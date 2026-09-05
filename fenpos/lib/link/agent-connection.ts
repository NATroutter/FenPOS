import "server-only";
import type { WebSocket } from "ws";
import { prisma } from "@/lib/db";
import { isTerminalJobStatus, TERMINAL_JOB_STATUSES } from "@/lib/domain/enums";
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
import { plausibleTime } from "@/lib/link/reported-time";
import { failRequests, settleReply } from "@/lib/link/requests";
import { logger } from "@/lib/logger";
import { ingestLog } from "@/lib/logs/ingest";
import { globalAgentSettings, globalJobSettings, integerSetting } from "@/lib/settings/settings-service";
import { queueJobSettled } from "@/lib/webhooks/notify";

/**
 * One agent's connection, from the opening handshake to close.
 *
 * The connection is authenticated before it reaches here, so this file is about what a agent
 * is allowed to *do* rather than who it is. That distinction matters: authentication happens
 * once, authorisation happens per frame. A agent may only ever affect its own resources, and
 * every handler re-establishes that rather than assuming it.
 */

/**
 * Queue depth applied when a device has no override.
 *
 * Mirrors the default the single-machine daemon used, so an install migrated from the old
 * configuration behaves the same until someone changes it deliberately.
 */
const DEFAULT_MAX_QUEUE_DEPTH = 100;

/**
 * Close codes used by the server, chosen from the application range.
 *
 * Mirrored in `LinkClient.java`, which acts on `unpaired` — the one code that must not be
 * followed by a reconnect.
 */
export const CLOSE = {
	/** The agent never completed the opening handshake. */
	handshakeTimeout: 4000,
	/** The agent offered a protocol version this server does not implement. */
	protocolMismatch: 4001,
	/** The agent sent something that could not be parsed as a valid frame. */
	badFrame: 4002,
	/**
	 * An operator unpaired the agent. Its credential is gone, so reconnecting would only ever be
	 * refused; the agent forgets the credential on seeing this and waits to be paired again.
	 */
	unpaired: 4003,
	/** The server is shutting down, or the agent was displaced by a newer connection. */
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
	let closed = false;
	let heartbeat: NodeJS.Timeout | undefined;
	let pongDeadline: NodeJS.Timeout | undefined;
	let handshakeTimer: NodeJS.Timeout | undefined;

	const link: AgentLink = {
		agentId: agent.id,
		agentName: agent.name,
		connectedAt: new Date(),
		address,
		pending: new Set<string>(),
		send(frame: ServerFrame): boolean {
			if (socket.readyState !== socket.OPEN) {
				return false;
			}
			socket.send(serialiseServerFrame(frame));
			return true;
		},
		close(reason: string, code: number = CLOSE.goingAway): void {
			socket.close(code, reason.slice(0, 120));
		},
	};

	/** Stops every timer this connection owns, so a closed socket leaves nothing running. */
	const clearTimers = (): void => {
		if (heartbeat) clearInterval(heartbeat);
		if (pongDeadline) clearTimeout(pongDeadline);
		heartbeat = undefined;
		pongDeadline = undefined;
	};

	/**
	 * Arms the handshake timeout once its configured length is known.
	 *
	 * The setting is read asynchronously, so this races the socket itself: `hello` can arrive, or
	 * the socket can close, before the read settles. Both are checked here rather than only at the
	 * handler that armed the timer, since a timer armed after either has already happened would
	 * otherwise fire — or leak — regardless.
	 */
	async function armHandshakeTimeout(): Promise<void> {
		const handshakeTimeoutMs = (await integerSetting("link.handshakeTimeoutSeconds")) * 1000;
		if (helloReceived || closed) {
			return;
		}
		handshakeTimer = setTimeout(() => {
			if (!helloReceived) {
				logger.warn("Agent did not complete the handshake", { agentId: agent.id, address });
				socket.close(CLOSE.handshakeTimeout, "hello not received");
			}
		}, handshakeTimeoutMs);
	}
	void armHandshakeTimeout();

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
			if (handshakeTimer) {
				clearTimeout(handshakeTimer);
			}
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
		closed = true;
		if (handshakeTimer) {
			clearTimeout(handshakeTimer);
		}
		clearTimers();

		// Only mark the agent offline if this connection is still the registered one. A late
		// close from a displaced socket must not overwrite the state of its replacement.
		if (unregisterLink(link)) {
			void markOffline(agent.id);
			// Everything this connection was going to answer, answered now. The socket is gone, so
			// the answer is not coming, and a panel action left spinning until its own timeout tells
			// an operator less than the truth does.
			const abandoned = failRequests(link.pending, "The agent disconnected before it answered.");
			if (abandoned > 0) {
				logger.info("Failed requests waiting on a agent that disconnected", {
					agentId: agent.id,
					count: abandoned,
				});
			}
			// Its printers are unreachable the moment the socket is, and a stale "connected"
			// chip is a confident wrong answer rather than an obvious absence.
			clearAgentStatus(agent.id);
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
			// Usually the previous socket is stale, otherwise the agent would not be reconnecting — and
			// that is the case this displacement exists for. But it is also what a stolen token looks
			// like: whoever holds the credential can knock the real agent offline every time it comes
			// back, indefinitely and from anywhere. Nothing here can tell the two apart, so both
			// addresses go in the record and at WARN, because a run of these from an address that is not
			// the shop's is the shape of the second case and there is nowhere else it would show.
			logger.warn("Displaced an earlier connection for this agent", {
				agentId: agent.id,
				agentName: agent.name,
				address,
				displacedAddress: displaced.address,
				displacedConnectedAt: displaced.connectedAt.toISOString(),
			});
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

		// Before the configuration goes out, so an agent that is about to be handed work is not
		// also being reconciled against. Skipped entirely when the frame carries no list: absent
		// means the agent has no answer, not that it holds nothing.
		if (frame.outstanding !== undefined) {
			await settleLostJobs(agent.id, frame.outstanding, link.connectedAt);
		}

		link.send({
			type: "welcome",
			protocolVersion: PROTOCOL_VERSION,
			agentId: agent.id,
			agentName: agent.name,
			serverTime: new Date().toISOString(),
		});

		await pushDeviceConfig(link, agent.id);

		void startHeartbeat();

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
	 * **A terminal job stays terminal.** The `status` predicate below is the second half of the same
	 * authorisation: an agent may report on its own jobs, but "how did this receipt end" is answered
	 * once. Without it an agent could walk a job COMPLETED → QUEUED → PRINTING at will, which is not
	 * a state any printer can be in and which rewrites the job history the panel and the API both
	 * read. It also makes a repeated report idempotent, which is what a retry after a dropped
	 * acknowledgement looks like.
	 *
	 * **The reported time is clamped.** `at` comes off the wire, so it is the agent's clock at best
	 * and its choice at worst — and it lands in `startedAt`/`finishedAt`, which the statistics read
	 * as durations. See {@link plausibleTime}.
	 *
	 * @param frame the reported state change
	 */
	async function onJobUpdate(frame: JobUpdateFrame): Promise<void> {
		const timestamps: Record<string, Date> = {};
		const reportedAt = plausibleTime(frame.at, "job update", { jobId: frame.jobId });

		if (frame.status === "PRINTING") {
			timestamps.startedAt = reportedAt;
		}
		if (isTerminalJobStatus(frame.status)) {
			timestamps.finishedAt = reportedAt;
		}

		try {
			const updated = await prisma.job.updateMany({
				where: { id: frame.jobId, agentId: agent.id, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
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
				// Three cases share this branch and none is an error: the job belongs to another agent,
				// the job is gone, or it has already settled and this is a repeat or a rewrite attempt.
				logger.warn("Job update ignored: no matching job that can still change", {
					agentId: agent.id,
					jobId: frame.jobId,
					reportedStatus: frame.status,
				});
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
				// The clamped time, not the raw one, so the live view and the row it will be reconciled
				// against agree about when this happened.
				at: reportedAt.toISOString(),
			});

			// After the write and after the panel's event, so a subscriber that reacts by reading the
			// row sees the state the delivery describes. Terminal states only: a caller wants to know
			// how a receipt ended, not that it started.
			if (frame.status === "COMPLETED" || frame.status === "FAILED" || frame.status === "CANCELLED") {
				// Inside this try for symmetry with everything above it, not because queueJobSettled
				// can throw — it never does, swallowing its own faults; see its doc comment.
				await queueJobSettled(frame.jobId);
			}
		} catch (error) {
			logger.error("Could not record a job update", error, { agentId: agent.id, jobId: frame.jobId });
		}
	}

	/**
	 * Starts the liveness probe.
	 *
	 * Each interval sends a ping; the first one with no deadline already outstanding also arms
	 * one. If the pong does not arrive before the deadline, the socket is terminated rather than
	 * closed: a half-open connection will not complete a closing handshake, so waiting for one
	 * would hang. At most one deadline is ever outstanding at a time — see the comment on
	 * `pongDeadline` inside the interval below for why arming a second one on top of an existing
	 * one is wrong regardless of how `link.heartbeatSeconds` and `link.heartbeatTimeoutSeconds`
	 * relate.
	 *
	 * Reads `link.heartbeatSeconds` and `link.heartbeatTimeoutSeconds` once, here, rather than once
	 * per ping — a connection lives far longer than a single interval, so this is a read per
	 * connection rather than a read per heartbeat. The setting is read asynchronously, so — as with
	 * {@link armHandshakeTimeout} — a socket that has already closed by the time it resolves must not
	 * still start pinging it.
	 */
	async function startHeartbeat(): Promise<void> {
		const heartbeatIntervalMs = (await integerSetting("link.heartbeatSeconds")) * 1000;
		const heartbeatTimeoutMs = (await integerSetting("link.heartbeatTimeoutSeconds")) * 1000;
		if (closed) {
			return;
		}

		heartbeat = setInterval(() => {
			if (socket.readyState !== socket.OPEN) {
				return;
			}

			alive = false;
			socket.ping();

			// A deadline from an earlier tick can still be outstanding here whenever
			// `link.heartbeatTimeoutSeconds` is configured above `link.heartbeatSeconds` — nothing
			// stops an operator setting it that way, since the two settings' bounds overlap and
			// this store validates one value at a time. Arming a second deadline on top of it
			// would leak the first: overwriting `pongDeadline` would drop the only reference able
			// to cancel it, so it fires later regardless of what happened since, against whatever
			// `alive` is by then. Clearing the old one and arming a fresh one instead of skipping
			// would stop the leak but trade it for a worse bug — an agent that never answers a
			// single ping would never be caught, because every tick would keep deferring the
			// deadline before it could ever elapse. Leaving the existing deadline alone until it
			// either fires or a pong clears it keeps exactly one outstanding no matter how the two
			// settings relate, and it still fires at the time the first unanswered ping promised.
			if (!pongDeadline) {
				pongDeadline = setTimeout(() => {
					if (!alive) {
						logger.warn("Agent stopped answering heartbeats", { agentId: agent.id });
						socket.terminate();
					}
				}, heartbeatTimeoutMs);
			}
		}, heartbeatIntervalMs);
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
 * Fails the jobs an agent no longer holds.
 *
 * A job's outcome reaches this server in one way only: an update from the agent that printed it.
 * That update is best effort — an agent whose link is down drops it rather than queueing it, and a
 * restart empties the agent's job store entirely — so a job dispatched and never heard about again
 * would sit queued for ever, which reads as a slow printer rather than as work that will never
 * finish. The handshake is where that is repairable, because it is the one moment the agent can say
 * what it still has.
 *
 * **Only jobs older than this connection.** A job submitted after this link registered was
 * submitted *on* it, and the agent will report it in the ordinary way; failing it here would settle
 * a receipt that is about to print. The agent's own list cannot mention it either, since it was
 * built before the socket opened.
 *
 * Each settled job is announced, because a caller subscribed to a webhook is waiting for exactly
 * this answer and would otherwise never receive one.
 *
 * @param agentId the agent that just connected
 * @param outstanding the job ids it says it still holds
 * @param connectedAt when this connection registered
 */
async function settleLostJobs(agentId: string, outstanding: string[], connectedAt: Date): Promise<void> {
	try {
		const lost = await prisma.job.findMany({
			where: {
				agentId,
				status: { notIn: [...TERMINAL_JOB_STATUSES] },
				submittedAt: { lt: connectedAt },
				...(outstanding.length > 0 ? { id: { notIn: outstanding } } : {}),
			},
			select: { id: true },
		});

		if (lost.length === 0) {
			return;
		}

		await prisma.job.updateMany({
			where: { id: { in: lost.map((job) => job.id) } },
			data: {
				status: "FAILED",
				finishedAt: new Date(),
				errorCode: "agent_lost_job",
				errorMessage: "The agent reconnected without this job, so its outcome is unknown.",
				// Cleared for the same reason `failJob` clears it: a caller who retries an
				// identical body must get a fresh attempt rather than a replay of a job that
				// never finished.
				idempotencyKey: null,
				idempotencyHash: null,
			},
		});

		logger.warn("Settled jobs an agent no longer holds", { agentId, count: lost.length });

		for (const job of lost) {
			await queueJobSettled(job.id);
		}
	} catch (error) {
		// Never fatal. The connection is worth more than the repair, and the next reconnect
		// tries again.
		logger.error("Could not settle jobs an agent no longer holds", error, { agentId });
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
			agent: await globalAgentSettings(),
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
