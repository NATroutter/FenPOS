import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ownUpgrades } from "@/lib/link/upgrade-owner";

/**
 * Reproduces the production failure that took every agent offline behind a Next 16 custom server.
 *
 * Next's custom-server wrapper registers its own `upgrade` listener on the process's HTTP server
 * the first time an ordinary request passes through it, and that listener ends any upgrade whose
 * path matches a route — which `/api/agent-link` does, through the API catch-all. Both listeners
 * run; ours yields at its first `await`, Next's `socket.end()` lands first, and the 101 (or 401)
 * written afterwards is a write after end that never reaches the wire. The client sees a closed
 * connection with no response and the server log shows nothing wrong.
 */
describe("ownUpgrades", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	/** Sends a raw upgrade request and returns what came back before the peer closed. */
	async function rawUpgrade(port: number): Promise<string> {
		return new Promise((resolve, reject) => {
			let received = "";
			const socket = connect(port, "127.0.0.1", () => {
				socket.write(
					"GET /api/agent-link HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
						"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
				);
			});
			socket.on("data", (chunk) => {
				received += chunk.toString("latin1");
			});
			socket.on("close", () => resolve(received));
			socket.on("error", reject);
		});
	}

	async function listen(target: Server): Promise<number> {
		await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
		return (target.address() as AddressInfo).port;
	}

	it("keeps a listener registered afterwards from ending the socket first", async () => {
		server = createServer();
		ownUpgrades(server, async (_request, socket) => {
			// The real handler looks the token up in the database before it answers.
			await delay(30);
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
		});

		// What Next does from inside its request handler, after the server is already serving.
		server.on("upgrade", (_request, socket) => {
			socket.end();
		});
		await delay(0);

		const port = await listen(server);
		expect(await rawUpgrade(port)).toMatch(/^HTTP\/1\.1 401/);
		expect(server.listenerCount("upgrade")).toBe(1);
	});

	it("still runs the owner for every upgrade", async () => {
		server = createServer();
		let seen = 0;
		ownUpgrades(server, (_request, socket) => {
			seen += 1;
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
			socket.destroy();
		});

		const port = await listen(server);
		expect(await rawUpgrade(port)).toMatch(/^HTTP\/1\.1 404/);
		expect(seen).toBe(1);
	});
});
