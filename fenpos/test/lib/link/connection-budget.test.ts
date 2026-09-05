import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { AGENT_LINK_PATH, attachAgentLink, type LinkUpgradeHandler } from "@/lib/link/link-server";

/**
 * Drives the link end to end over a real HTTP server and a real WebSocket client, in the same
 * shape `test/lib/link/link-server.test.ts` uses — a mocked socket would not catch a rejected
 * handshake or a refusal arriving at the wrong point in the upgrade.
 */
describe("agent connection budget", () => {
	let server: Server;
	let baseUrl: string;
	const open: WebSocket[] = [];

	beforeAll(async () => {
		server = createServer((_request, response) => {
			response.statusCode = 404;
			response.end();
		});
		attachAgentLink(server);

		const handleLink = (server as Server & { fenposLinkUpgrade?: LinkUpgradeHandler }).fenposLinkUpgrade;
		server.on("upgrade", (request, socket, head) => {
			const path = new URL(request.url ?? "/", "http://localhost").pathname;
			if (path === AGENT_LINK_PATH && handleLink) {
				handleLink(request, socket, head);
				return;
			}
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
			socket.destroy();
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		baseUrl = `ws://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	afterEach(async () => {
		for (const socket of open.splice(0)) {
			socket.close();
		}
		// Give close handlers a turn, so registry state does not leak between tests.
		await delay(60);
		await prisma.job.deleteMany({});
		await prisma.agent.deleteMany({});
	});

	/** Creates a paired agent and returns its bearer token. */
	async function pairedAgent(name = "kitchen"): Promise<{ id: string; token: string }> {
		const token = `test-token-${name}-${Math.random().toString(36).slice(2)}`;
		const agent = await prisma.agent.create({
			data: { name, tokenHash: hashSecret(token), status: "OFFLINE" },
			select: { id: true },
		});
		return { id: agent.id, token };
	}

	/** Opens a client socket, tracked so it is closed after the test. */
	function connect(token?: string): WebSocket {
		const socket = new WebSocket(`${baseUrl}${AGENT_LINK_PATH}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		open.push(socket);
		return socket;
	}

	it("refuses a credential that reconnects far faster than any agent would", async () => {
		// Every connect costs a settings read, a token lookup, a device query and a dither of each
		// stored image. The agent's own backoff never produces more than a handful a minute, so a
		// caller that does is either broken or is holding a credential it should not have — and in
		// either case it also displaces whatever connection was there before it.
		const agent = await pairedAgent();

		let refused = 0;
		for (let attempt = 0; attempt < 20; attempt++) {
			const socket = connect(agent.token);
			const outcome = await new Promise<"open" | string>((resolve) => {
				socket.once("open", () => resolve("open"));
				socket.once("error", (error: Error) => resolve(error.message));
			});
			if (outcome !== "open" && outcome.includes("429")) {
				refused++;
			}
			socket.close();
		}

		expect(refused).toBeGreaterThan(0);
	});

	it("keeps one agent's connection budget clear of another behind the same address", async () => {
		// Several tills behind one shop's router share an address, so a budget that bound them
		// together would let a chatty or compromised till take the others offline with it. The
		// address limiter cannot make this distinction; the per-credential budget is what does.
		const noisy = await pairedAgent("noisy");
		const quiet = await pairedAgent("quiet");

		let refused = 0;
		for (let attempt = 0; attempt < 15; attempt++) {
			const socket = connect(noisy.token);
			const outcome = await new Promise<"open" | string>((resolve) => {
				socket.once("open", () => resolve("open"));
				socket.once("error", (error: Error) => resolve(error.message));
			});
			if (outcome !== "open" && outcome.includes("429")) {
				refused++;
			}
			socket.close();
		}

		// The noisy one spent its own budget...
		expect(refused).toBeGreaterThan(0);

		// ...and the quiet one still has all of its own.
		const socket = connect(quiet.token);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		expect(socket.readyState).toBe(WebSocket.OPEN);
	});
});
