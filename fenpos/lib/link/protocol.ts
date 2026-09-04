import { z } from "zod";
import {
	Align,
	BarcodeSystem,
	Codepage,
	ConnectionStatus,
	Font,
	JobStatus,
	Linefeed,
	LogLevel,
} from "@/lib/domain/enums";

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
 *
 * Bumped 1 -> 2 for the QR, BARCODE, PDF417 and DRAWER directives. `FrameCodec.readDirective`
 * on the agent throws `ProtocolException("unknown directive type")` on anything it does not
 * recognise, and a stale agent jar — easy to have lying in `agent/target` — would otherwise
 * connect happily to a new server and then fail partway through the first receipt containing
 * a block. `Hello`/`Welcome` compare this value exactly, so the bump turns that into a clean
 * refusal at connect time, which is the failure worth having while both sides are moving.
 *
 * Bumped 2 -> 3 for the IMAGE directive, the config.sync asset payload, and making `columns`
 * required on the PDF417 directive — a version-2 agent would not recognise the new directive
 * or payload, and would silently fall back to printer-decided layout on a version-2 PDF417
 * block that omits `columns`, which is exactly the ambiguity the field was added to remove.
 */
export const PROTOCOL_VERSION = 3;

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

/**
 * Bounds on the image data this protocol carries.
 *
 * Every one of these sits *inside* {@link MAX_FRAME_BYTES}, which remains the bound that actually
 * decides: a frame is measured and refused before it is parsed, so no product of the counts below
 * can be allocated. They exist to refuse a single implausible value early and with a message that
 * names it, the same way `MAX_RAW_CHARS` does on the agent.
 */
export const IMAGE_LIMITS = {
	/**
	 * Base64 characters in one raster, whether synced or carried in a job.
	 *
	 * 128 KB encodes 96 KB of dots, which on the widest common paper is a picture about 1500 dots
	 * tall — some sixty lines of paper, and far more than any logo. It is also what one job may
	 * spend on images in total; see `MAX_INLINE_IMAGE_CHARS` in `lib/markup/resolve-images.ts`,
	 * which is what stops several smaller images adding up to a frame nothing will send.
	 */
	maxRasterChars: 128 * 1024,
	/** Rasters one `config.sync` may carry: one per asset per distinct paper width behind an agent. */
	maxSyncedRasters: 32,
	/** Printed width of a raster, in dots. Well beyond the ~576 of the widest common paper. */
	maxWidthDots: 4096,
	/** Printed height of a raster, in dots — what `GS v 0` encodes in its two vertical bytes. */
	maxHeightDots: 65_535,
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

/**
 * An asset's name, which follows the device rule and for the same reason.
 *
 * Aliased rather than restated so the two cannot drift: an asset name is written into markup, into
 * log lines and into this protocol, and one slug rule for every name in the system is what keeps
 * escaping out of every consumer.
 */
const assetNameSchema = deviceNameSchema;

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
	/**
	 * Refused rather than escaped, because there is no escaping: the agent writes this text
	 * to the port through the device's codepage, and every codepage maps U+001B to 0x1B. A
	 * control character here is an ESC/POS command. The markup parser already refuses them
	 * in source text and in variable values; this is the same rule on the wire, so a frame
	 * this server builds can never carry one even if a future compile path forgets.
	 */
	text: z
		.string()
		.max(JOB_LIMITS.maxSpanChars)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
		.refine((value) => !/[\x00-\x1f\x7f-\x9f]/.test(value), "must not contain control characters"),
	bold: z.boolean(),
	/** Underline thickness: 0 for none, 1 or 2 for the two ESC/POS weights. */
	underline: z.union([z.literal(0), z.literal(1), z.literal(2)]),
	invert: z.boolean(),
	widthMult: z.number().int().min(1).max(8),
	heightMult: z.number().int().min(1).max(8),
	font: Font.schema,
});

/**
 * The shape of a dithered raster wherever one crosses this link.
 *
 * **The server owns dithering.** A thermal head has one ink and no greys, and deciding each dot is
 * work that has to happen once, against a known paper width, by the same code the panel's preview
 * draws with — otherwise what is on screen and what comes off the paper disagree. So an agent never
 * receives an image; it receives dots.
 *
 * `data` is one bit per dot, most significant bit first, each row padded to a whole byte, a set bit
 * being ink. That is exactly the layout an ESC/POS `GS v 0` raster takes, and exactly what
 * `ditherToRaster` in `lib/assets/dither.ts` produces, so nothing between the two reorders a bit.
 */
const rasterFields = {
	widthDots: z.number().int().min(1).max(IMAGE_LIMITS.maxWidthDots),
	heightDots: z.number().int().min(1).max(IMAGE_LIMITS.maxHeightDots),
	/** The dots, base64 encoded. */
	data: z.string().min(1).max(IMAGE_LIMITS.maxRasterChars),
};

/** How many bytes a raster of this size occupies: whole bytes per row, one row per dot of height. */
export function rasterBytes(widthDots: number, heightDots: number): number {
	return Math.ceil(widthDots / 8) * heightDots;
}

/**
 * Whether a raster's bits fill the rectangle it claims.
 *
 * The one check on this schema that is worth more than a type. A raster shorter than its declared
 * height leaves the printer waiting for bytes that never arrive — it stops mid-image and needs a
 * power cycle, not a failed job — so the two are compared wherever a raster is described, on the way
 * out as well as on the way in.
 *
 * Measured on the decoded bytes rather than on the base64 text, because base64 encodes four, five
 * and six bytes to the same eight characters: a length check on the text would admit a raster two
 * rows short. Re-encoding is what makes the decode trustworthy — `Buffer.from` silently skips
 * characters it does not recognise, so text that does not come back unchanged was not base64.
 */
const fillsItsRectangle = (raster: { widthDots: number; heightDots: number; data: string }) => {
	const decoded = Buffer.from(raster.data, "base64");
	return (
		decoded.length === rasterBytes(raster.widthDots, raster.heightDots) && decoded.toString("base64") === raster.data
	);
};

const RECTANGLE_MESSAGE = "raster data must be base64 of one bit per dot, rows padded to a whole byte";

/**
 * Where an image's dots come from, and the one asymmetry in this protocol.
 *
 * **A stored asset's dots are already on the agent.** They travel with `config.sync` — one raster
 * per asset per distinct paper width behind that agent — so they cross the link once per change
 * rather than once per receipt, and a job only has to name one. That is why stored assets are the
 * documented default for `<image>`.
 *
 * **A URL image's dots cannot be pre-synced**, because nothing knows the URL until someone writes
 * it into a receipt. They therefore ride inside the job, base64, every time it prints. A logo is a
 * few kilobytes, which is affordable per job and is strictly worse than the stored path: it is the
 * concrete cost of the live-URL option, alongside the fetch the compile already waits on.
 *
 * A reference carries `widthDots` rather than the tag's percentage. The agent then looks a raster up
 * by exactly the number the server dithered it at, instead of repeating the percentage arithmetic
 * and having to agree about rounding — the same reason `<hr>` is expanded to characters server-side.
 * A width the server did not sync is never referenced: the compiler sends those dots inline, because
 * resizing a raster that has already been reduced to black and white resamples the dither's own
 * noise and turns a logo into mud.
 */
const imageSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("REF"), ref: assetNameSchema, widthDots: rasterFields.widthDots }),
	z.object({ kind: z.literal("INLINE"), ...rasterFields }).refine(fillsItsRectangle, RECTANGLE_MESSAGE),
]);

/** Longest linear barcode payload, which is what `GS k` function B's one-byte length field can declare. */
const MAX_BARCODE_CHARS = 255;

/**
 * Characters the mandatory Code 128 code-set selector occupies ahead of the payload, mirroring
 * `CODE128_SET_B`'s length in the agent's `EscPosRenderer`. The selector counts toward the same
 * one-byte length field as the content itself, so a Code 128 payload must leave room for it.
 */
const CODE128_SET_SELECTOR_CHARS = 2;

/** A printer action that is not text. */
export const directiveSchema = z
	.discriminatedUnion("type", [
		z.object({ type: z.literal("CUT"), mode: z.enum(["FULL", "PARTIAL"]) }),
		z.object({ type: z.literal("FEED"), lines: z.number().int().min(1).max(255) }),
		/**
		 * Symbol payload bounds are the symbologies' own capacities, not round numbers. They also keep
		 * each payload inside what its ESC/POS command can declare: `GS k` function B states its length
		 * in one byte and `GS ( k` in two, so a longer payload declares a shorter one and the printer
		 * reads the remainder as commands. The agent restates all three in `FrameCodec`.
		 */
		z.object({
			type: z.literal("QR"),
			content: z.string().min(1).max(4_296),
			size: z.number().int().min(1).max(16),
		}),
		z.object({
			type: z.literal("BARCODE"),
			system: BarcodeSystem.schema,
			content: z.string().min(1).max(MAX_BARCODE_CHARS),
		}),
		/**
		 * `columns` is the symbol's data-column count, and it is the one piece of measured geometry on
		 * this schema.
		 *
		 * Everything else a symbol needs, the agent's library computes for itself — which is why QR and
		 * BARCODE carry no size. PDF417 is different because `GS ( k` function 65 defaults to zero and
		 * a printer reads zero as "lay it out however you like". The server has already charged a line
		 * budget against a particular layout, so leaving the choice to the firmware makes those two
		 * different symbols. Bounded 1..30 because that is what function 65 encodes and what
		 * `PDF417.setNumberOfColumns` accepts; zero is deliberately outside the range, so "printer
		 * decides" cannot be expressed on this wire at all.
		 */
		z.object({
			type: z.literal("PDF417"),
			content: z.string().min(1).max(1_850),
			errorLevel: z.number().int().min(0).max(8),
			columns: z.number().int().min(1).max(30),
		}),
		z.object({ type: z.literal("DRAWER"), pin: z.union([z.literal(2), z.literal(5)]) }),
		z.object({ type: z.literal("IMAGE"), source: imageSourceSchema }),
	])
	.refine(
		(directive) =>
			directive.type !== "BARCODE" ||
			directive.system !== "CODE128" ||
			directive.content.length <= MAX_BARCODE_CHARS - CODE128_SET_SELECTOR_CHARS,
		"a CODE128 barcode's content must leave room for the two-character code-set selector its command prepends",
	);

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

/**
 * One stored image, dithered for one of an agent's paper widths.
 *
 * Keyed by name and width because that pair is what a job names. An agent with an 80mm and a 58mm
 * printer behind it receives two entries for the same asset, since a raster dithered for one is not
 * a picture on the other — see `lib/assets/dither.ts`.
 */
export const assetRasterSchema = z
	.object({ name: assetNameSchema, ...rasterFields })
	.refine(fillsItsRectangle, RECTANGLE_MESSAGE);

export type AssetRaster = z.infer<typeof assetRasterSchema>;

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
 * Job retention and shutdown, as the server has them configured.
 *
 * Bounds are the panel's, restated here because this is a wire contract: a frame is validated by
 * whoever receives it, and a receiver that trusted the sender's range checks would be trusting the
 * sender. The agent applies the same bounds — see `FrameCodec`.
 */
export const jobSettingsSchema = z.object({
	retentionMinutes: z.number().int().min(1).max(40_320),
	maxRecords: z.number().int().min(100).max(1_000_000),
	shutdownGraceSeconds: z.number().int().min(1).max(300),
});

/**
 * Agent-side timing knobs, as the server has them configured.
 *
 * A sibling of {@link jobSettingsSchema} rather than fields added to it: these three govern the
 * agent's own status-report cadence, job-eviction sweep and print-queue poll, not job retention or
 * shutdown, and folding unrelated knobs into `jobs` would make that object mean "everything the
 * agent needs" rather than "what governs a job's life on the agent" — the same wire cost is paid
 * either way, since both cross on the same `config.sync` frame, but the shape stays honest about
 * what each field is for. Bounds are restated here, and again in `FrameCodec.readAgentSettings` on
 * the agent, for the same reason `jobSettingsSchema`'s are: a receiver validates what crosses this
 * wire regardless of who sent it.
 */
export const agentSettingsSchema = z.object({
	statusIntervalSeconds: z.number().int().min(5).max(300),
	evictionIntervalSeconds: z.number().int().min(10).max(3_600),
	queuePollMs: z.number().int().min(20).max(2_000),
});

/**
 * Server to agent: the authoritative device set.
 *
 * Sent whole rather than as a delta. A full snapshot is idempotent, so a agent that missed an
 * update while disconnected converges on reconnect without either side tracking what the
 * other has seen.
 *
 * It carries the stored images too, because they are configuration by the same argument: an agent
 * needs them before any job arrives, they change rarely, and a whole snapshot converges without
 * either side remembering what the other holds. The cost of that idempotence is that the dots are
 * re-sent on every reconnect rather than only when they change — a few kilobytes per asset per
 * paper width, paid once at connect instead of once per receipt, which is the same trade this frame
 * already makes for the device set.
 *
 * It carries the job settings by the same argument again: an agent needs its retention, record
 * cap, and shutdown grace before any job arrives, and re-sending them on every reconnect costs
 * nothing worth tracking a delta to avoid.
 *
 * It carries the agent's own timing settings for the same reason once more: the status report
 * interval, the job eviction interval and the print queue poll interval were each a fixed constant
 * on the agent until they crossed this wire, and re-sending them here rather than opening a second
 * frame just for them is the same trade `jobs` already makes.
 */
export const configSyncSchema = z.object({
	type: z.literal("config.sync"),
	devices: z.array(deviceConfigSchema).max(256),
	assets: z.array(assetRasterSchema).max(IMAGE_LIMITS.maxSyncedRasters),
	/**
	 * Optional so the frame stays compatible in both directions: an agent built before this field
	 * existed ignores it, and one built after it falls back to its own defaults when an older
	 * server omits it. Neither pairing refuses the frame, which a required field would have made
	 * them do.
	 */
	jobs: jobSettingsSchema.optional(),
	/** Optional for the same bidirectional-compatibility reason `jobs` is. */
	agent: agentSettingsSchema.optional(),
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
 * The one frame that hands arbitrary bytes to hardware. Two callers can raise it: an admin session
 * on the Tools tab, and an API key that holds `devices:raw` on an install whose
 * `link.allowRawApiWrites` setting has been switched on — it ships off — and only for a printer that
 * key is granted. Either way the payload is size capped here and audit logged on the way out.
 * Everything else in this protocol is a description of what to print; this is the printer's own
 * language, and a wrong byte sequence can leave a device needing a power cycle.
 *
 * The `bytes` bound below is the wire's own limit and the authority for everything above it: the
 * agent's `FrameCodec` mirrors it as `MAX_RAW_CHARS`, and the `link.maxRawWriteBytes` setting derives
 * its maximum from it rather than restating a number (`rawWriteByteCeiling` in
 * `lib/settings/settings-service.ts`), so a payload an operator is allowed to configure always fits
 * in a frame. Widening it here widens that setting with it — and the agent has to be widened in the
 * same change, or it will reject what this side now sends.
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

/**
 * Server to agent: act on one printer.
 *
 * `jobId` accompanies `device.test` only. The test page is composed on the agent, but the server
 * records it as a job first and hands the id over, so the page reports through the same
 * `job.update` frames as a dispatched job and appears in the Jobs tab like one. Optional on the
 * wire so an older server's command, which carries no id, still prints — as an unrecorded page.
 */
export const deviceCommandSchema = z.object({
	type: z.enum(DEVICE_COMMANDS),
	requestId: requestIdSchema,
	device: deviceNameSchema,
	jobId: idSchema.optional(),
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
 * A frame this server built that is too large to send.
 *
 * **The agent does not merely refuse an oversized frame — it closes the link.** `LinkClient.java`
 * treats one as a protocol violation, which is right on the receiving side and is exactly why the
 * sending side must never produce one: a single job that overran the cap would drop the connection
 * and take every printer behind that agent offline until it reconnected.
 *
 * Its own type so callers can tell it from a schema failure. A schema failure is a bug in this
 * server; this one is usually a property of what a caller asked to print, and the caller can be told
 * so instead of watching their printers disappear.
 */
export class FrameTooLargeError extends Error {
	constructor(
		readonly bytes: number,
		frameType: string,
	) {
		super(`A ${frameType} frame of ${bytes} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`);
		this.name = "FrameTooLargeError";
	}
}

/**
 * Serialises a frame for transmission to a agent.
 *
 * Validated on the way out as well as on the way in. The cost is negligible next to the
 * failure it prevents: a malformed dispatch would be rejected by the agent after the server
 * had already recorded the job as sent.
 *
 * **Measured as well as validated.** The size is checked here rather than at the socket because this
 * is the one place every outgoing frame passes through, and because refusing before the write is the
 * whole point: the agent closes the link on an oversized frame, so a frame that is built and then
 * sent has already done the damage. Nothing downstream of this function can send what it refuses.
 *
 * @param frame the frame to send
 * @returns the JSON text to write to the socket
 * @throws Error when the frame does not satisfy its schema, which is a server bug
 * @throws FrameTooLargeError when it would exceed {@link MAX_FRAME_BYTES}
 */
export function serialiseServerFrame(frame: ServerFrame): string {
	const parsed = serverFrameSchema.parse(frame);
	const text = JSON.stringify(parsed);

	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_FRAME_BYTES) {
		throw new FrameTooLargeError(bytes, parsed.type);
	}

	return text;
}
