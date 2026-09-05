import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { AGENT_LINK_PATH, attachAgentLink, type LinkUpgradeHandler } from "@/lib/link/link-server";
import { MAX_OUTSTANDING_JOBS, PROTOCOL_VERSION, parseAgentFrame } from "@/lib/link/protocol";

/**
 * Drives the reconciliation path over a real HTTP server and a real WebSocket client, the same
 * way `link-server.test.ts` drives the rest of the handshake — a mocked socket would not catch a
 * handler wired to the wrong point in the handshake.
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

	describe("settling what an agent no longer holds", () => {
		/** Creates a device and a job in the given state, and returns the job's id. */
		async function jobFor(agentId: string, status: string): Promise<string> {
			const device = await prisma.device.findFirst({ where: { agentId }, select: { id: true } });
			const target =
				device ??
				(await prisma.device.create({ data: { agentId, name: "printer", port: "COM1" }, select: { id: true } }));
			const job = await prisma.job.create({
				data: { agentId, deviceId: target.id, status, submittedAt: new Date(Date.now() - 60_000) },
				select: { id: true },
			});
			return job.id;
		}

		it("fails a job the agent does not name", async () => {
			const agent = await pairedAgent();
			const stranded = await jobFor(agent.id, "QUEUED");

			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			socket.send(helloFrame({ outstanding: [] }));
			await frameAt(socket, 1);
			await delay(120);

			const stored = await prisma.job.findUniqueOrThrow({ where: { id: stranded } });
			expect(stored.status).toBe("FAILED");
			expect(stored.errorCode).toBe("agent_lost_job");
			expect(stored.finishedAt).not.toBeNull();
		});

		it("leaves a job the agent still names alone", async () => {
			const agent = await pairedAgent();
			const live = await jobFor(agent.id, "PRINTING");

			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			socket.send(helloFrame({ outstanding: [live] }));
			await frameAt(socket, 1);
			await delay(120);

			expect((await prisma.job.findUniqueOrThrow({ where: { id: live } })).status).toBe("PRINTING");
		});

		it("settles nothing when the agent sends no list at all", async () => {
			// An older agent, or one with too many outstanding to report honestly. Absent means
			// "no information", and acting on it would fail jobs that are printing.
			const agent = await pairedAgent();
			const untouched = await jobFor(agent.id, "QUEUED");

			const socket = connect(agent.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			socket.send(helloFrame());
			await frameAt(socket, 1);
			await delay(120);

			expect((await prisma.job.findUniqueOrThrow({ where: { id: untouched } })).status).toBe("QUEUED");
		});

		it("never settles another agent's job", async () => {
			const mine = await pairedAgent("mine");
			const theirs = await pairedAgent("theirs");
			const notMine = await jobFor(theirs.id, "QUEUED");

			const socket = connect(mine.token);
			await new Promise<void>((resolve) => socket.once("open", resolve));
			socket.send(helloFrame({ outstanding: [] }));
			await frameAt(socket, 1);
			await delay(120);

			expect((await prisma.job.findUniqueOrThrow({ where: { id: notMine } })).status).toBe("QUEUED");
		});

		it("refuses an outstanding list longer than the cap", async () => {
			const tooMany = Array.from({ length: MAX_OUTSTANDING_JOBS + 1 }, (_, index) => `job-${index}`);
			const result = parseAgentFrame(helloFrame({ outstanding: tooMany }));
			expect(result.ok).toBe(false);
		});
	});
});
