import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PinnedAddress } from "@/lib/assets/fetch-remote";
import { httpSender } from "@/lib/webhooks/deliver";

/**
 * The one function in webhook delivery that opens a socket.
 *
 * Every other test in `deliver.test.ts` passes its own `Sender`, so the real one — the part that
 * builds the request, pins where it connects, and decides what a timeout means — was the only piece
 * of the module nothing exercised. It is also the piece that was rewritten from `fetch` to
 * `node:http`, because `fetch` cannot be told which address to connect to and the check that
 * approves an address is worth nothing if the connection then asks DNS again.
 *
 * A real loopback server rather than a mock, because what is being tested is exactly the part a mock
 * would replace: that the bytes reach a socket, that the headers are the ones a receiver has to
 * verify a signature, and that the pinned address is the one used.
 */

/** What one received request looked like to the server. */
interface Received {
	method: string;
	url: string;
	headers: IncomingMessage["headers"];
	body: string;
}

let running: Server | undefined;

/**
 * Starts a loopback server that answers every request the same way.
 *
 * @param respond decides the status, and may stall
 * @returns the server's base URL and the requests it has received
 */
async function serve(
	respond: (received: Received) => Promise<number> | number,
): Promise<{ origin: string; port: number; received: Received[] }> {
	const received: Received[] = [];

	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const entry: Received = {
				method: request.method ?? "",
				url: request.url ?? "",
				headers: request.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			};
			received.push(entry);
			void (async () => {
				const status = await respond(entry);
				response.writeHead(status);
				response.end();
			})();
		});
	});

	running = server;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${port}`, port, received };
}

/** The loopback address, pinned the way `assertDeliverable` hands its approved set over. */
const LOOPBACK: PinnedAddress[] = [{ address: "127.0.0.1", family: 4 }];

afterEach(async () => {
	if (running) {
		await new Promise<void>((resolve) => {
			running?.close(() => resolve());
		});
		running = undefined;
	}
});

describe("the real webhook sender", () => {
	it("posts the body and the signature, and reports the status", async () => {
		const { origin, received } = await serve(() => 202);

		const result = await httpSender(`${origin}/hook`, LOOPBACK, '{"event":"job.settled"}', "t=1,v1=abc", 2_000);

		expect(result).toEqual({ status: 202 });
		expect(received).toHaveLength(1);
		expect(received[0].method).toBe("POST");
		expect(received[0].url).toBe("/hook");
		expect(received[0].body).toBe('{"event":"job.settled"}');
		expect(received[0].headers["x-fenpos-signature"]).toBe("t=1,v1=abc");
		expect(received[0].headers["content-type"]).toBe("application/json");
		expect(received[0].headers["user-agent"]).toBe("FenPOS-Webhook/1");
	});

	it("declares the body's length in bytes, not characters", async () => {
		const { origin, received } = await serve(() => 200);
		// Four characters, ten bytes. A `Content-Length` counted in characters truncates the body at
		// the receiver, which is the kind of failure that only shows up on non-ASCII payloads.
		const body = '{"n":"åäö"}';

		await httpSender(`${origin}/hook`, LOOPBACK, body, "sig", 2_000);

		expect(received[0].headers["content-length"]).toBe(String(Buffer.byteLength(body, "utf8")));
		expect(received[0].body).toBe(body);
	});

	it("keeps the query string the registered URL carries", async () => {
		const { origin, received } = await serve(() => 200);

		await httpSender(`${origin}/hook?tenant=7&k=v`, LOOPBACK, "{}", "sig", 2_000);

		expect(received[0].url).toBe("/hook?tenant=7&k=v");
	});

	/**
	 * The finding this rewrite exists for. The URL names a host that resolves to nothing, so a sender
	 * that asked DNS would fail; pinning is what makes the request arrive. The `Host` header still
	 * carries the hostname, which is what keeps virtual hosting and certificate validation working.
	 */
	it("connects to the pinned address rather than resolving the hostname again", async () => {
		const { port, received } = await serve(() => 200);

		const result = await httpSender(`http://webhook.invalid:${port}/hook`, LOOPBACK, "{}", "sig", 2_000);

		expect(result).toEqual({ status: 200 });
		expect(received[0].headers.host).toBe(`webhook.invalid:${port}`);
	});

	it("reports a redirect as its own status rather than following it", async () => {
		const { origin, received } = await serve(() => 302);

		const result = await httpSender(`${origin}/hook`, LOOPBACK, "{}", "sig", 2_000);

		// `processDelivery` treats a 3xx as permanent, which is only true if nothing followed it.
		expect(result).toEqual({ status: 302 });
		expect(received).toHaveLength(1);
	});

	it("gives up on a receiver that never answers, rather than waiting forever", async () => {
		const { origin } = await serve(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5_000));
			return 200;
		});

		const started = Date.now();
		await expect(httpSender(`${origin}/hook`, LOOPBACK, "{}", "sig", 200)).rejects.toThrow();

		// The bound is the point, not the message: an attempt that outlived its budget would also
		// outlive the lease `processDelivery` took on the row.
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("rejects when nothing is listening, so the failure is retryable rather than silent", async () => {
		// Port 1 on loopback: reserved, and nothing in this suite binds it.
		await expect(httpSender("http://webhook.invalid:1/hook", LOOPBACK, "{}", "sig", 2_000)).rejects.toThrow();
	});
});
