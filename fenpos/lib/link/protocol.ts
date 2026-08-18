import { z } from "zod";
import { Align, Codepage, ConnectionStatus, Font, JobStatus, Linefeed, LogLevel } from "@/lib/domain/enums";

/**
 * The wire contract between the server and a agent.
 *
 * This module is the single definition of what may cross the link. Both directions are
 * validated against it: the server does not trust a agent merely because it authenticated,
 * and the agent does not trust the server merely because it is the server. Either side
 * receiving a frame it cannot parse rejects that frame and continues, rather than crashing
 * or acting on a partial reading.
 *
 * Every bound here exists to make a hostile or faulty peer harmless. Sizes are capped so a
 * single frame cannot exhaust memory, and closed value sets are reused from the domain
 * module so a value that would be unrepresentable on a printer cannot be encoded at all.
 *
 * The Java counterpart lives in `agent/src/main/java/fi/natroutter/fenpos/link/`. Changing a
 * schema here without changing it there produces a job that is accepted and then fails on
 * the far side, so the two must move together.
 */

/**
 * Protocol version, exchanged in the opening handshake.
 *
 * Incremented only for a change that an older peer could misread. A agent announcing a
 * version the server does not implement is refused at the handshake with a clear reason,
 * which is far easier to diagnose than frames failing individually later.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Largest frame accepted, in bytes.
 *
 * A print job of the maximum permitted size renders well under this. The cap is what stops
 * a peer streaming an unbounded frame to exhaust the receiver's memory before any schema
 * validation can run.
 */
export const MAX_FRAME_BYTES = 256 * 1024;

/** Bounds on a dispatched job, applied on both sides. */
export const JOB_LIMITS = {
	/** Printed lines in one job, after wrapping. */
	maxLines: 1000,
	/** Styled runs within one line. */
	maxSpansPerLine: 64,
	/** Characters in one span. */
	maxSpanChars: 512,
	/** Directives attached to one line. */
	maxDirectivesPerLine: 8,
} as const;

/** Identifier shapes, bounded so an oversized value cannot be stored or logged. */
const idSchema = z.string().min(1).max(64);
const deviceNameSchema = z
	.string()
	.min(1)
	.max(64)
	// Names appear in API paths and in log lines. Restricting them here means no consumer
	// has to escape them, which is a smaller surface than remembering to escape everywhere.
	.regex(/^[a-z0-9][a-z0-9_-]*$/, "must be lowercase alphanumeric with dashes or underscores");

// ---------------------------------------------------------------------------
// Compiled job representation
// ---------------------------------------------------------------------------

/**
 * A styled run of text.
 *
 * Styles are fully resolved rather than expressed as a tag stack, which is what lets the
 * agent render a span without tracking state across the line, and what let the server wrap
 * text by width without reopening tags at the break.
 */
export const spanSchema = z.object({
	text: z.string().max(JOB_LIMITS.maxSpanChars),
	bold: z.boolean(),
	/** Underline thickness: 0 for none, 1 or 2 for the two ESC/POS weights. */
	underline: z.union([z.literal(0), z.literal(1), z.literal(2)]),
	invert: z.boolean(),
	widthMult: z.number().int().min(1).max(8),
	heightMult: z.number().int().min(1).max(8),
	font: Font.schema,
});

/** A printer action that is not text. */
export const directiveSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("CUT"), mode: z.enum(["FULL", "PARTIAL"]) }),
	z.object({ type: z.literal("FEED"), lines: z.number().int().min(1).max(255) }),
]);

/**
 * One printed line.
 *
 * Alignment is a line property because ESC/POS justification applies to a whole line; a line
 * with no spans and only directives emits its directives without advancing the paper.
 */
export const lineSchema = z.object({
	align: Align.schema,
	spans: z.array(spanSchema).max(JOB_LIMITS.maxSpansPerLine),
	directives: z.array(directiveSchema).max(JOB_LIMITS.maxDirectivesPerLine),
});

/** The compiled, validated job the agent renders. */
export const compiledJobSchema = z.object({
	jobId: idSchema,
	device: deviceNameSchema,
	linefeed: Linefeed.schema,
	lines: z.array(lineSchema).max(JOB_LIMITS.maxLines),
});

export type Span = z.infer<typeof spanSchema>;
export type Directive = z.infer<typeof directiveSchema>;
export type Line = z.infer<typeof lineSchema>;
export type CompiledJob = z.infer<typeof compiledJobSchema>;

// ---------------------------------------------------------------------------
// Device configuration pushed to a agent
// ---------------------------------------------------------------------------

/**
 * A device as the agent needs to know it.
 *
 * Only what is required to open the port and render correctly. The server keeps the rest —
 * grants, limits, job history — because the agent has no decision to make with it.
 */
export const deviceConfigSchema = z.object({
	name: deviceNameSchema,
	port: z.string().min(1).max(256),
	baudRate: z.number().int().min(50).max(4_000_000),
	dataBits: z.number().int().min(5).max(8),
	stopBits: z.number().int().min(1).max(2),
	parity: z.enum(["NONE", "ODD", "EVEN", "MARK", "SPACE"]),
	flowControl: z.enum(["NONE", "RTS", "CTS", "DSR", "DTR", "XONXOFF_IN", "XONXOFF_OUT"]),
	writeTimeoutMs: z.number().int().min(100).max(120_000),
	autoConnect: z.boolean(),
	autoReconnect: z.boolean(),
	reconnectDelaySeconds: z.number().int().min(1).max(3600),
	columns: z.number().int().min(1).max(255),
	codepage: Codepage.schema,
	paused: z.boolean(),
	/** Queue depth beyond which the agent rejects further dispatches for this device. */
	maxQueueDepth: z.number().int().min(1).max(10_000),
});

export type DeviceConfig = z.infer<typeof deviceConfigSchema>;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * Agent to server: the opening frame, sent once per connection.
 *
 * Carries no credential — the token is presented in the upgrade request, so a connection
 * that reaches this point is already authenticated. What it carries is the agent's own
 * account of itself, which the server records for display and treats as untrusted text.
 */
export const helloSchema = z.object({
	type: z.literal("hello"),
	protocolVersion: z.number().int(),
	agentVersion: z.string().max(64),
	platform: z.string().max(128),
	hostname: z.string().max(255),
});

/** Server to agent: accepted, here is who you are. */
export const welcomeSchema = z.object({
	type: z.literal("welcome"),
	protocolVersion: z.number().int(),
	agentId: idSchema,
	agentName: z.string().max(128),
	/** Server time, so a agent with a wrong clock can report timings the server can align. */
	serverTime: z.string().datetime(),
});

/**
 * Server to agent: the authoritative device set.
 *
 * Sent whole rather than as a delta. A full snapshot is idempotent, so a agent that missed an
 * update while disconnected converges on reconnect without either side tracking what the
 * other has seen.
 */
export const configSyncSchema = z.object({
	type: z.literal("config.sync"),
	devices: z.array(deviceConfigSchema).max(256),
});

/** Server to agent: print this. */
export const jobDispatchSchema = z.object({
	type: z.literal("job.dispatch"),
	job: compiledJobSchema,
});

/**
 * Server to agent: withdraw a job if it has not started.
 *
 * A request rather than an instruction. Only the machine holding the printer knows whether the
 * job is still waiting or already halfway through the paper, so the outcome comes back as an
 * ordinary job update rather than being assumed here.
 */
export const jobCancelSchema = z.object({
	type: z.literal("job.cancel"),
	jobId: idSchema,
});

/**
 * Agent to server: a job changed state.
 *
 * `at` is the agent's clock. The server records it for ordering within a job but keeps its
 * own timestamps for anything it must compare across agents, since agent clocks are not
 * synchronised with each other.
 */
export const jobUpdateSchema = z.object({
	type: z.literal("job.update"),
	jobId: idSchema,
	status: JobStatus.schema,
	at: z.string().datetime(),
	/** Printed lines, present once the job has rendered. */
	lines: z.number().int().min(0).optional(),
	/** Rendered ESC/POS byte count, present once the job has rendered. */
	bytes: z.number().int().min(0).optional(),
	errorCode: z.string().max(64).optional(),
	errorMessage: z.string().max(512).optional(),
});

// ---------------------------------------------------------------------------
// Device control
// ---------------------------------------------------------------------------

/**
 * Correlates a request with its reply.
 *
 * Present only on frames that have an answer. The panel is usually waiting on a specific
 * request — a scan it just started, a port it just asked to open — and without correlation it
 * would have to guess which reply was its own, which goes wrong precisely when two operators
 * are working at once.
 */
const requestIdSchema = z.string().min(1).max(64);

/**
 * Server to agent: write these bytes to the printer, unmodified.
 *
 * The one frame that hands arbitrary bytes to hardware. Reachable only from an admin session —
 * no API key can ever be granted it — size capped, and audit logged on the way out. Everything
 * else in this protocol is a description of what to print; this is the printer's own language,
 * and a wrong byte sequence can leave a device needing a power cycle.
 */
export const rawWriteSchema = z.object({
	type: z.literal("raw.write"),
	requestId: requestIdSchema,
	device: deviceNameSchema,
	/** The bytes, base64 encoded. */
	bytes: z.string().max(16_384),
});

/** Server to agent: enumerate the serial ports this machine can see. */
export const portsScanSchema = z.object({
	type: z.literal("ports.scan"),
	requestId: requestIdSchema,
});

/**
 * One serial port an agent reported.
 *
 * Every field is the operating system's own text and is treated as untrusted: it is rendered
 * as text, never as markup, because a USB device's descriptor strings are chosen by whoever
 * made the device.
 */
export const serialPortSchema = z.object({
	name: z.string().min(1).max(256),
	description: z.string().max(256),
	vendorId: z.number().int().min(0).max(0xffff),
	productId: z.number().int().min(0).max(0xffff),
	serialNumber: z.string().max(128),
});

/** Agent to server: the answer to a scan. */
export const portsResultSchema = z.object({
	type: z.literal("ports.result"),
	requestId: requestIdSchema,
	ports: z.array(serialPortSchema).max(256),
});

/** What an operator can ask an agent to do to one of its printers. */
export const DEVICE_COMMANDS = [
	"device.connect",
	"device.disconnect",
	"device.pause",
	"device.resume",
	"device.clearQueue",
	"device.test",
] as const;

export type DeviceCommand = (typeof DEVICE_COMMANDS)[number];

/** Server to agent: act on one printer. */
export const deviceCommandSchema = z.object({
	type: z.enum(DEVICE_COMMANDS),
	requestId: requestIdSchema,
	device: deviceNameSchema,
});

/**
 * Agent to server: what came of a command.
 *
 * Carries the agent's own words on failure — "Could not open COM3; it may be in use by another
 * process" is the sentence that tells an operator what to do, and only the machine with the
 * port can produce it. A server-side approximation would be a guess.
 */
export const commandResultSchema = z.object({
	type: z.literal("command.result"),
	requestId: requestIdSchema,
	ok: z.boolean(),
	message: z.string().max(512).optional(),
});

/** One printer's observed state, as the agent sees it right now. */
export const deviceStatusSchema = z.object({
	name: deviceNameSchema,
	connection: ConnectionStatus.schema,
	paused: z.boolean(),
	/** Jobs waiting for this printer, not counting the one being written. */
	queueDepth: z.number().int().min(0),
});

/**
 * Agent to server: the observed state of every device.
 *
 * Pushed after anything changes and on a slow timer, rather than polled. Observed state lives
 * only in memory on both sides — a socket cannot outlive its process, so a persisted
 * "connected" would be wrong from the moment either end restarts.
 */
export const statusReportSchema = z.object({
	type: z.literal("status.report"),
	devices: z.array(deviceStatusSchema).max(256),
});

/**
 * Agent to server: something worth recording happened.
 *
 * Forwarded rather than mirrored: the agent keeps its own local log regardless, and this is the
 * subset an operator watching the panel needs to see. Rate limited and length capped on receipt,
 * because a agent stuck in a failure loop would otherwise fill the database with the same line.
 */
export const logSchema = z.object({
	type: z.literal("log"),
	level: LogLevel.schema,
	message: z.string().min(1).max(1000),
	/** The device this concerns, when it concerns one. */
	device: deviceNameSchema.optional(),
	/** The agent's clock, ISO-8601 in UTC. */
	at: z.string().datetime(),
});

export type SerialPortInfo = z.infer<typeof serialPortSchema>;
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;
export type PortsResultFrame = z.infer<typeof portsResultSchema>;
export type CommandResultFrame = z.infer<typeof commandResultSchema>;
export type StatusReportFrame = z.infer<typeof statusReportSchema>;
export type LogFrame = z.infer<typeof logSchema>;

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

/**
 * Every frame a agent may send.
 *
 * Liveness is deliberately absent: WebSocket has native ping and pong control frames, and
 * Java's HttpClient replies to a ping automatically. Restating that in the application
 * protocol would add code on both sides to reimplement something the transport already does
 * correctly.
 */
export const agentFrameSchema = z.discriminatedUnion("type", [
	helloSchema,
	jobUpdateSchema,
	portsResultSchema,
	commandResultSchema,
	statusReportSchema,
	logSchema,
]);

/** Every frame the server may send. */
export const serverFrameSchema = z.union([
	welcomeSchema,
	configSyncSchema,
	jobDispatchSchema,
	jobCancelSchema,
	portsScanSchema,
	deviceCommandSchema,
	rawWriteSchema,
]);

export type AgentFrame = z.infer<typeof agentFrameSchema>;
export type ServerFrame = z.infer<typeof serverFrameSchema>;
export type HelloFrame = z.infer<typeof helloSchema>;
export type JobUpdateFrame = z.infer<typeof jobUpdateSchema>;

/** Why a received frame was rejected. */
export interface FrameRejection {
	reason: "too_large" | "invalid_json" | "invalid_frame";
	detail: string;
}

/**
 * Parses and validates a frame received from a agent.
 *
 * Returns a result rather than throwing, because a bad frame is an expected operational
 * condition on a link open to the internet, not an exceptional one. The caller logs it and
 * keeps the connection, so one malformed frame cannot disconnect a working printer.
 *
 * @param raw the frame as received
 * @returns the parsed frame, or the reason it was rejected
 */
export function parseAgentFrame(raw: string): { ok: true; frame: AgentFrame } | { ok: false; error: FrameRejection } {
	if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) {
		return {
			ok: false,
			error: { reason: "too_large", detail: `frame exceeds ${MAX_FRAME_BYTES} bytes` },
		};
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		return {
			ok: false,
			error: { reason: "invalid_json", detail: error instanceof Error ? error.message : "unparseable" },
		};
	}

	const result = agentFrameSchema.safeParse(decoded);
	if (!result.success) {
		return {
			ok: false,
			error: { reason: "invalid_frame", detail: result.error.issues.map((issue) => issue.message).join("; ") },
		};
	}

	return { ok: true, frame: result.data };
}

/**
 * Serialises a frame for transmission to a agent.
 *
 * Validated on the way out as well as on the way in. The cost is negligible next to the
 * failure it prevents: a malformed dispatch would be rejected by the agent after the server
 * had already recorded the job as sent.
 *
 * @param frame the frame to send
 * @returns the JSON text to write to the socket
 * @throws Error when the frame does not satisfy its schema, which is a server bug
 */
export function serialiseServerFrame(frame: ServerFrame): string {
	return JSON.stringify(serverFrameSchema.parse(frame));
}
