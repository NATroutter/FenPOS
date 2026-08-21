import "server-only";
import type { WebSocket } from "ws";
import { prisma } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { rastersFor } from "@/lib/link/asset-sync";
import { clearAgentStatus, recordStatus } from "@/lib/link/device-status";
import {
	type DeviceConfig,
	deviceConfigSchema,
	type HelloFrame,
	type JobUpdateFrame,
	MAX_FRAME_BYTES,
	PROTOCOL_VERSION,
	parseAgentFrame,
	type ServerFrame,
	serialiseServerFrame,
} from "@/lib/link/protocol";
import { type AgentLink, connectedAgentIds, getLink, registerLink, unregisterLink } from "@/lib/link/registry";
import { settleReply } from "@/lib/link/requests";
import { logger } from "@/lib/logger";
import { clearLogWindow, ingestLog } from "@/lib/logs/ingest";
import { globalJobSettings } from "@/lib/settings/settings-service";

/**
 * One agent's connection, from the opening handshake to close.
 *
 * The connection is authenticated before it reaches here, so this file is about what a agent
 * is allowed to *do* rather than who it is. That distinction matters: authentication happens
 * once, authorisation happens per frame. A agent may only ever affect its own resources, and
 * every handler re-establishes that rather than assuming it.
 */

/**
 * How often the server pings an idle connection.
 *
 * Native WebSocket pings, not application frames — the transport already does this correctly
 * and Java's client answers automatically.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long a agent has to answer a ping before the connection is considered dead.
 *
 * A silent half-open socket is the failure this catches: TCP will happily hold a connection
 * open for many minutes after the peer has gone, during which the server would believe a
 * printer was reachable and queue jobs into nothing.
 */
const HEARTBEAT_TIMEOUT_MS = 10_000;

/** How long a agent has to send `hello` before the connection is dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Queue depth applied when a device has no override.
 *
 * Mirrors the default the single-machine daemon used, so an install migrated from the old
 * configuration behaves the same until someone changes it deliberately.
 */
const DEFAULT_MAX_QUEUE_DEPTH = 100;

/** Close codes used by the server, chosen from the application range. */
const CLOSE = {
	/** The agent never completed the opening handshake. */
	handshakeTimeout: 4000,
	/** The agent offered a protocol version this server does not implement. */
	protocolMismatch: 4001,
	/** The agent sent something that could not be parsed as a valid frame. */
	badFrame: 4002,
	/** The server is shutting down, or the agent was displaced or unpaired. */
	goingAway: 1001,
} as const;

/** Identity established during the upgrade, before any frame is read. */
export interface AuthenticatedAgent {
	id: string;
	name: string;
}

/**
 * Attaches the protocol to an authenticated socket.
 *
 * Returns once the connection is wired up; the connection then runs until it closes.
 *
 * @param socket the upgraded WebSocket
 * @param agent the identity established during the upgrade
 * @param address the agent's network address, for logging
 */
export function handleAgentConnection(socket: WebSocket, agent: AuthenticatedAgent, address: string): void {
	let helloReceived = false;
	let alive = true;
	let heartbeat: NodeJS.Timeout | undefined;
	let pongDeadline: NodeJS.Timeout | undefined;

	const link: AgentLink = {
		agentId: agent.id,
		agentName: agent.name,
		connectedAt: new Date(),
		send(frame: ServerFrame): boolean {
			if (socket.readyState !== socket.OPEN) {
				return false;
			}
			socket.send(serialiseServerFrame(frame));
			return true;
		},
		close(reason: string): void {
			socket.close(CLOSE.goingAway, reason.slice(0, 120));
		},
	};

	/** Stops every timer this connection owns, so a closed socket leaves nothing running. */
	const clearTimers = (): void => {
		if (heartbeat) clearInterval(heartbeat);
		if (pongDeadline) clearTimeout(pongDeadline);
		heartbeat = undefined;
		pongDeadline = undefined;
	};

	const handshakeTimer = setTimeout(() => {
		if (!helloReceived) {
			logger.warn("Agent did not complete the handshake", { agentId: agent.id, address });
			socket.close(CLOSE.handshakeTimeout, "hello not received");
		}
	}, HANDSHAKE_TIMEOUT_MS);

	socket.on("message", (data, isBinary) => {
		// The protocol is text. A binary frame is either a different protocol or a probe, and
		// decoding it as UTF-8 to find out would be doing an attacker's work for them.
		if (isBinary) {
			logger.warn("Agent sent a binary frame", { agentId: agent.id });
			socket.close(CLOSE.badFrame, "binary frames are not part of this protocol");
			return;
		}

		const raw = data.toString();
		const parsed = parseAgentFrame(raw);

		if (!parsed.ok) {
			// A malformed frame does not close a working printer's connection unless it is
			// oversized, which indicates the peer is not speaking this protocol at all.
			logger.warn("Rejected a frame from a agent", {
				agentId: agent.id,
				reason: parsed.error.reason,
				detail: parsed.error.detail,
			});
			if (parsed.error.reason === "too_large") {
				socket.close(CLOSE.badFrame, `frames must be under ${MAX_FRAME_BYTES} bytes`);
			}
			return;
		}

		if (parsed.frame.type === "hello") {
			if (helloReceived) {
				logger.warn("Agent sent a second hello", { agentId: agent.id });
				return;
			}
			helloReceived = true;
			clearTimeout(handshakeTimer);
			void onHello(parsed.frame);
			return;
		}

		if (!helloReceived) {
			// Ordering is part of the contract: accepting work before the handshake would mean
			// acting on a peer whose protocol version is still unknown.
			logger.warn("Agent sent a frame before hello", { agentId: agent.id, type: parsed.frame.type });
			return;
		}

		switch (parsed.frame.type) {
			case "job.update":
				void onJobUpdate(parsed.frame);
				break;
			case "status.report": {
				const devices = parsed.frame.devices;
				recordStatus(agent.id, devices);
				publish({
					kind: "device",
					agentId: agent.id,
					devices: devices.map((device) => ({
						name: device.name,
						connection: device.connection,
						paused: device.paused,
						queueDepth: device.queueDepth,
					})),
					at: new Date().toISOString(),
				});
				break;
			}
			case "log":
				void ingestLog(agent.id, parsed.frame);
				break;
			case "ports.result":
			case "command.result":
				// A reply nobody is waiting for is dropped. That is what a reply arriving after
				// its timeout looks like, and also what an agent inventing request ids looks
				// like; the same silence makes both harmless.
				if (!settleReply(parsed.frame.requestId, parsed.frame)) {
					logger.warn("Reply to a request nobody is waiting for", {
						agentId: agent.id,
						type: parsed.frame.type,
					});
				}
				break;
		}
	});

	socket.on("pong", () => {
		alive = true;
		if (pongDeadline) {
			clearTimeout(pongDeadline);
			pongDeadline = undefined;
		}
	});

	socket.on("close", (code, reason) => {
		clearTimeout(handshakeTimer);
		clearTimers();

		// Only mark the agent offline if this connection is still the registered one. A late
		// close from a displaced socket must not overwrite the state of its replacement.
		if (unregisterLink(link)) {
			void markOffline(agent.id);
			// Its printers are unreachable the moment the socket is, and a stale "connected"
			// chip is a confident wrong answer rather than an obvious absence.
			clearAgentStatus(agent.id);
			clearLogWindow(agent.id);
			publish({
				kind: "agent",
				agentId: agent.id,
				agentName: agent.name,
				online: false,
				at: new Date().toISOString(),
			});
			// Named `closeCode` rather than `code` so the logger's redaction list — which
			// exists to catch pairing codes — does not swallow a diagnostic value.
			logger.info("Agent disconnected", {
				agentId: agent.id,
				agentName: agent.name,
				closeCode: code,
				reason: reason.toString(),
			});
		}
	});

	socket.on("error", (error) => {
		// Transport errors are ordinary on a link to a shop network. Logged, never fatal; the
		// close event that follows performs the cleanup.
		logger.warn("Agent connection error", { agentId: agent.id, message: error.message });
	});

	/**
	 * Completes the handshake: version check, registration, and the initial state push.
	 *
	 * @param frame the agent's opening frame
	 */
	async function onHello(frame: HelloFrame): Promise<void> {
		if (frame.protocolVersion !== PROTOCOL_VERSION) {
			logger.warn("Refused a agent on protocol version", {
				agentId: agent.id,
				offeredVersion: frame.protocolVersion,
				serverVersion: PROTOCOL_VERSION,
			});
			socket.close(
				CLOSE.protocolMismatch,
				`server speaks protocol ${PROTOCOL_VERSION}, agent offered ${frame.protocolVersion}`,
			);
			return;
		}

		const displaced = registerLink(link);
		if (displaced) {
			// The previous socket is stale, otherwise the agent would not be reconnecting.
			logger.info("Displaced an earlier connection for this agent", { agentId: agent.id });
			displaced.close("replaced by a newer connection");
		}

		try {
			await prisma.agent.update({
				where: { id: agent.id },
				data: {
					status: "ONLINE",
					lastSeenAt: new Date(),
					agentVersion: frame.agentVersion,
					platform: frame.platform,
					hostname: frame.hostname,
					lastAddress: address,
				},
			});
		} catch (error) {
			logger.error("Could not record agent as online", error, { agentId: agent.id });
		}

		link.send({
			type: "welcome",
			protocolVersion: PROTOCOL_VERSION,
			agentId: agent.id,
			agentName: agent.name,
			serverTime: new Date().toISOString(),
		});

		await pushDeviceConfig(link, agent.id);

		startHeartbeat();

		publish({
			kind: "agent",
			agentId: agent.id,
			agentName: agent.name,
			online: true,
			at: new Date().toISOString(),
		});

		logger.info("Agent connected", {
			agentId: agent.id,
			agentName: agent.name,
			address,
			agentVersion: frame.agentVersion,
			hostname: frame.hostname,
		});
	}

	/**
	 * Records a job state change reported by the agent.
	 *
	 * The update is scoped to jobs belonging to this agent, which is the authorisation check
	 * that stops one agent reporting on — or corrupting — another's work. A job id that does
	 * not match is ignored rather than treated as an error, because it is also what a stale
	 * report from before a job was deleted looks like.
	 *
	 * @param frame the reported state change
	 */
	async function onJobUpdate(frame: JobUpdateFrame): Promise<void> {
		const timestamps: Record<string, Date> = {};
		const reportedAt = new Date(frame.at);

		if (frame.status === "PRINTING") {
			timestamps.startedAt = reportedAt;
		}
		if (frame.status === "COMPLETED" || frame.status === "FAILED" || frame.status === "CANCELLED") {
			timestamps.finishedAt = reportedAt;
		}

		try {
			const updated = await prisma.job.updateMany({
				where: { id: frame.jobId, agentId: agent.id },
				data: {
					status: frame.status,
					...timestamps,
					...(frame.lines === undefined ? {} : { lines: frame.lines }),
					...(frame.bytes === undefined ? {} : { bytes: frame.bytes }),
					...(frame.errorCode === undefined ? {} : { errorCode: frame.errorCode }),
					...(frame.errorMessage === undefined ? {} : { errorMessage: frame.errorMessage }),
				},
			});

			if (updated.count === 0) {
				logger.warn("Job update for an unknown job", { agentId: agent.id, jobId: frame.jobId });
				return;
			}

			// Published after the write, so a subscriber that reacts by reading the row sees the
			// state the event describes rather than the one it replaced.
			const job = await prisma.job.findUnique({
				where: { id: frame.jobId },
				select: { device: { select: { name: true } } },
			});

			publish({
				kind: "job",
				jobId: frame.jobId,
				status: frame.status,
				agentId: agent.id,
				deviceName: job?.device.name ?? "",
				at: frame.at,
			});
		} catch (error) {
			logger.error("Could not record a job update", error, { agentId: agent.id, jobId: frame.jobId });
		}
	}

	/**
	 * Starts the liveness probe.
	 *
	 * Each interval sends a ping and arms a deadline. If the pong does not arrive before the
	 * deadline, the socket is terminated rather than closed: a half-open connection will not
	 * complete a closing handshake, so waiting for one would hang.
	 */
	function startHeartbeat(): void {
		heartbeat = setInterval(() => {
			if (socket.readyState !== socket.OPEN) {
				return;
			}

			alive = false;
			socket.ping();

			pongDeadline = setTimeout(() => {
				if (!alive) {
					logger.warn("Agent stopped answering heartbeats", { agentId: agent.id });
					socket.terminate();
				}
			}, HEARTBEAT_TIMEOUT_MS);
		}, HEARTBEAT_INTERVAL_MS);
	}
}

/**
 * Records a agent as offline.
 *
 * @param agentId the agent that disconnected
 */
async function markOffline(agentId: string): Promise<void> {
	try {
		await prisma.agent.updateMany({
			where: { id: agentId },
			data: { status: "OFFLINE", lastSeenAt: new Date() },
		});
	} catch (error) {
		logger.error("Could not record agent as offline", error, { agentId });
	}
}

/**
 * Sends the agent its authoritative device set, and the images its receipts may draw on.
 *
 * A whole snapshot rather than a delta, so a agent that missed changes while disconnected
 * converges without either side tracking what the other has seen.
 *
 * The stored images travel here rather than in each job that prints them: they change rarely and an
 * agent must hold them before a job arrives, which is the same argument that puts the device set
 * here. See `asset-sync.ts` for which rasters an agent needs and how many of them fit.
 *
 * @param link the connection to send on
 * @param agentId the agent whose devices to send
 */
export async function pushDeviceConfig(link: AgentLink, agentId: string): Promise<void> {
	try {
		const rows = await prisma.device.findMany({ where: { agentId }, orderBy: { name: "asc" } });

		const devices: DeviceConfig[] = [];
		for (const row of rows) {
			// Prisma types these columns as plain `string` because SQLite has no enums, so
			// each row is validated rather than asserted. A row that fails is skipped and
			// reported: pushing an unparseable codepage would hand a printer bytes it cannot
			// render, and asserting the type would hide that until paper came out wrong.
			const parsed = deviceConfigSchema.safeParse({
				name: row.name,
				port: row.port,
				baudRate: row.baudRate,
				dataBits: row.dataBits,
				stopBits: row.stopBits,
				parity: row.parity,
				flowControl: row.flowControl,
				writeTimeoutMs: row.writeTimeoutMs,
				autoConnect: row.autoConnect,
				autoReconnect: row.autoReconnect,
				reconnectDelaySeconds: row.reconnectDelaySeconds,
				columns: row.columns,
				codepage: row.codepage,
				paused: row.paused,
				maxQueueDepth: row.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
			});

			if (parsed.success) {
				devices.push(parsed.data);
			} else {
				logger.error("Skipped a device with invalid stored configuration", undefined, {
					agentId,
					deviceId: row.id,
					deviceName: row.name,
					problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
				});
			}
		}

		// After the devices are settled, because which rasters an agent needs follows from the paper
		// widths of the devices it actually has — and a device whose stored configuration would not
		// parse is not one of them.
		link.send({
			type: "config.sync",
			devices,
			assets: await rastersFor(devices, agentId),
			jobs: await globalJobSettings(),
		});
	} catch (error) {
		logger.error("Could not push device configuration", error, { agentId });
	}
}

/**
 * Sends every connected agent a fresh snapshot.
 *
 * What the stored images need that the device set does not: a device belongs to one agent, so
 * changing it concerns one connection, while the image library is shared by all of them. An upload
 * that only reached agents which happened to reconnect afterwards would leave the same receipt
 * printing a logo in one shop and failing for want of it in another.
 *
 * Sent as a whole configuration rather than as an images-only frame, because there is no such frame
 * and adding one would mean a second thing for both sides to keep in step for no gain: the snapshot
 * is idempotent, so re-sending the devices alongside changes nothing an agent does.
 *
 * Failures are logged rather than raised. The change is already stored, agents converge on their
 * next connection, and telling an operator their upload failed would be untrue.
 */
export async function pushConfigToEveryAgent(): Promise<void> {
	await Promise.all(
		connectedAgentIds().map(async (agentId) => {
			const link = getLink(agentId);
			if (link) {
				await pushDeviceConfig(link, agentId);
			}
		}),
	);
}
