import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { scanPorts } from "@/lib/link/commands";
import { AGENT_LINK_PATH, attachAgentLink, type LinkUpgradeHandler } from "@/lib/link/link-server";
import { PROTOCOL_VERSION } from "@/lib/link/protocol";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Tests that a request waiting on an agent is failed the moment that agent's connection closes,
 * rather than left to run out its own timeout.
 *
 * Driven over a real HTTP server and a real WebSocket client, the same shape
 * `test/lib/link/link-server.test.ts` uses, because what is being proven is that the close event
 * the server actually fires reaches the requests actually waiting on it — a mocked socket would
 * only prove the handlers were wired up, not that they run in the right order relative to each
 * other.
 */
describe("pending requests on a closed connection", () => {
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
		await delay(60);
		await prisma.job.deleteMany({});
		await prisma.agent.deleteMany({});
		await prisma.setting.deleteMany({});
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

	const buffers = new WeakMap<WebSocket, Record<string, unknown>[]>();

	/** Opens a client socket, tracked so it is closed after the test. */
	function connect(token?: string): WebSocket {
		const socket = new WebSocket(`${baseUrl}${AGENT_LINK_PATH}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		open.push(socket);

		const received: Record<string, unknown>[] = [];
		buffers.set(socket, received);
		socket.on("message", (data, isBinary) => {
			if (!isBinary) {
				received.push(JSON.parse(data.toString()));
			}
		});

		return socket;
	}

	/**
	 * Waits for the frame at the given position, counting from the first the socket received.
	 *
	 * @param socket the client socket
	 * @param index zero-based position in the stream of frames
	 * @returns the frame
	 */
	async function frameAt(socket: WebSocket, index: number): Promise<Record<string, unknown>> {
		const received = buffers.get(socket);
		if (!received) {
			throw new Error("socket was not opened through connect()");
		}

		const deadline = Date.now() + 5000;
		while (received.length <= index) {
			if (socket.readyState === WebSocket.CLOSED) {
				throw new Error(`socket closed after ${received.length} frame(s)`);
			}
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for frame ${index}; received ${received.length}`);
			}
			await delay(10);
		}
		return received[index];
	}

	function helloFrame(overrides: Record<string, unknown> = {}): string {
		return JSON.stringify({
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			agentVersion: "1.0.0",
			platform: "linux-x64",
			hostname: "kitchen-pi",
			...overrides,
		});
	}

	it("fails a scan the moment its agent disconnects", async () => {
		// An operator who pressed Scan and got nothing back cannot tell a port that will not open
		// from a link that dropped the request, and those need different actions from them. Waiting
		// out the full timeout over a question that already has an answer is the worst of both.
		await setSetting("link.scanTimeoutSeconds", 120);
		const agent = await pairedAgent();

		const socket = connect(agent.token);
		await new Promise<void>((resolve) => socket.once("open", resolve));
		socket.send(helloFrame());
		await frameAt(socket, 1);

		const started = Date.now();
		const scan = scanPorts(agent.id).catch((error: Error) => error.message);
		await delay(50);
		socket.close();

		const message = await scan;
		expect(message).toContain("disconnected");
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 20_000);
});
