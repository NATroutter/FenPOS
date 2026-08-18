import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { AGENT_LINK_PATH, attachAgentLink, type LinkUpgradeHandler } from "@/lib/link/link-server";
import { PROTOCOL_VERSION } from "@/lib/link/protocol";
import { connectedAgentIds, getLink, isConnected } from "@/lib/link/registry";

/**
 * Drives the link end to end over a real HTTP server and a real WebSocket client.
 *
 * A mocked socket would prove only that the handlers were called; it would not catch a
 * broken upgrade, a rejected handshake, or a close event arriving in the wrong order — which
 * are the failures that actually take printers offline.
 */
describe("agent link", () => {
	let server: Server;
	let baseUrl: string;
	const open: WebSocket[] = [];

	beforeAll(async () => {
		server = createServer((_request, response) => {
			response.statusCode = 404;
			response.end();
		});
		attachAgentLink(server);

		// Mirrors the routing in server.ts: the link only handles its own path, and anything
		// else is left for another listener. In the real process that is Next's hot-reload
		// transport; here nothing claims it, so the socket is refused.
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

	/**
	 * Buffers every frame a socket receives.
	 *
	 * Necessary because the server answers `hello` with `welcome` and `config.sync`
	 * back-to-back. Attaching a fresh one-shot listener per read would drop the second frame
	 * whenever it arrives before the next read is issued — a race the test would lose
	 * intermittently rather than reliably, which is worse than failing outright.
	 */
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

	/** Waits for the first frame, which is the common case. */
	function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
		return frameAt(socket, 0);
	}

	/** Resolves with the close code when the socket closes. */
	function closeCode(socket: WebSocket): Promise<number> {
		return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
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

	describe("upgrade authentication", () => {
		it("refuses a connection with no token", async () => {
			const socket = connect();
			const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
			expect(error.message).toContain("401");
		});

		it("refuses an unrecognised token", async () => {
			const socket = connect("not-a-real-token");
			const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
			expect(error.message).toContain("401");
		});

		it("refuses a token whose agent was unpaired", async () => {
			const agent = await pairedAgent();
			await prisma.agent.update({ where: { id: agent.id }, data: { tokenHash: null } });

			const socket = connect(agent.token);
			const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
			// This is what makes unpairing take effect: the credential stops resolving.
			expect(error.message).toContain("401");
		});

		it("refuses an upgrade on any other path", async () => {
			const agent = await pairedAgent();
			const socket = new WebSocket(`${baseUrl}/api/something-else`, {
				headers: { Authorization: `Bearer ${agent.token}` },
			});
			open.push(socket);

			const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
			expect(error.message).toContain("404");
		});

		it("accepts a valid token", async () => {
			const agent = await pairedAgent();
			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			expect(socket.readyState).toBe(WebSocket.OPEN);
		});
	});

	describe("handshake", () => {
		it("answers hello with welcome and a config snapshot", async () => {
			const agent = await pairedAgent();
			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));

			socket.send(helloFrame());

			expect(await frameAt(socket, 0)).toMatchObject({
				type: "welcome",
				agentId: agent.id,
				protocolVersion: PROTOCOL_VERSION,
			});
			expect(await frameAt(socket, 1)).toMatchObject({ type: "config.sync", devices: [] });
		});

		it("marks the agent online and registers the link", async () => {
			const agent = await pairedAgent();
			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));

			socket.send(helloFrame());
			await nextFrame(socket);
			await delay(80);

			expect(isConnected(agent.id)).toBe(true);
			const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
			expect(stored.status).toBe("ONLINE");
			expect(stored.hostname).toBe("kitchen-pi");
		});

		it("closes a agent offering a protocol version it does not implement", async () => {
			const agent = await pairedAgent();
			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));

			socket.send(helloFrame({ protocolVersion: PROTOCOL_VERSION + 1 }));

			expect(await closeCode(socket)).toBe(4001);
		});

		it("ignores work sent before the handshake", async () => {
			const agent = await pairedAgent();
			const device = await prisma.device.create({
				data: { agentId: agent.id, name: "printer", port: "COM1" },
				select: { id: true },
			});
			const job = await prisma.job.create({
				data: { agentId: agent.id, deviceId: device.id, status: "QUEUED" },
				select: { id: true },
			});

			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));

			// Sent without a preceding hello: the peer's protocol version is still unknown, so
			// acting on this would mean trusting a peer that has not identified itself.
			socket.send(
				JSON.stringify({ type: "job.update", jobId: job.id, status: "COMPLETED", at: new Date().toISOString() }),
			);
			await delay(120);

			const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
			expect(stored.status).toBe("QUEUED");
		});
	});

	describe("job updates", () => {
		it("records a state change for its own job", async () => {
			const agent = await pairedAgent();
			const device = await prisma.device.create({
				data: { agentId: agent.id, name: "printer", port: "COM1" },
				select: { id: true },
			});
			const job = await prisma.job.create({
				data: { agentId: agent.id, deviceId: device.id, status: "QUEUED" },
				select: { id: true },
			});

			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			socket.send(helloFrame());
			await nextFrame(socket);

			socket.send(
				JSON.stringify({
					type: "job.update",
					jobId: job.id,
					status: "COMPLETED",
					at: new Date().toISOString(),
					lines: 12,
					bytes: 418,
				}),
			);
			await delay(120);

			const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
			expect(stored.status).toBe("COMPLETED");
			expect(stored.lines).toBe(12);
			expect(stored.finishedAt).not.toBeNull();
		});

		it("refuses to update a job belonging to another agent", async () => {
			const mine = await pairedAgent("mine");
			const theirs = await pairedAgent("theirs");

			const device = await prisma.device.create({
				data: { agentId: theirs.id, name: "printer", port: "COM1" },
				select: { id: true },
			});
			const job = await prisma.job.create({
				data: { agentId: theirs.id, deviceId: device.id, status: "QUEUED" },
				select: { id: true },
			});

			const socket = connect(mine.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			socket.send(helloFrame());
			await nextFrame(socket);

			// Authentication established who this agent is; it must not let it act for another.
			socket.send(
				JSON.stringify({ type: "job.update", jobId: job.id, status: "FAILED", at: new Date().toISOString() }),
			);
			await delay(120);

			const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
			expect(stored.status).toBe("QUEUED");
		});
	});

	describe("connection lifecycle", () => {
		it("marks the agent offline when it disconnects", async () => {
			const agent = await pairedAgent();
			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			socket.send(helloFrame());
			await nextFrame(socket);
			await delay(80);

			socket.close();
			await delay(150);

			expect(isConnected(agent.id)).toBe(false);
			const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
			expect(stored.status).toBe("OFFLINE");
		});

		it("displaces an older connection when the agent reconnects", async () => {
			const agent = await pairedAgent();

			const first = connect(agent.token);
			await new Promise<void>((resolve) => first.once("open", resolve));
			first.send(helloFrame());
			await nextFrame(first);
			await delay(80);
			const firstLink = getLink(agent.id);

			const second = connect(agent.token);
			await new Promise<void>((resolve) => second.once("open", resolve));
			second.send(helloFrame());
			await nextFrame(second);
			await delay(150);

			// The stale socket must not remain registered, or dispatches would be written to a
			// connection nobody is reading and the jobs would vanish.
			expect(getLink(agent.id)).not.toBe(firstLink);
			expect(connectedAgentIds()).toEqual([agent.id]);
			expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({ status: "ONLINE" });
		});

		it("keeps the connection open when a malformed frame arrives", async () => {
			const agent = await pairedAgent();
			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			socket.send(helloFrame());
			await nextFrame(socket);

			socket.send("{ not json at all");
			await delay(120);

			// One bad frame must not take a working printer offline.
			expect(socket.readyState).toBe(WebSocket.OPEN);
			expect(isConnected(agent.id)).toBe(true);
		});

		it("closes a connection that sends a binary frame", async () => {
			const agent = await pairedAgent();
			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			socket.send(helloFrame());
			await nextFrame(socket);

			socket.send(Buffer.from([0x00, 0x01, 0x02]));

			expect(await closeCode(socket)).toBe(4002);
		});
	});
});
