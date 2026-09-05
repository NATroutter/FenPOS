import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	agentSettingsSchema,
	configSyncSchema,
	directiveSchema,
	FrameTooLargeError,
	IMAGE_LIMITS,
	JOB_LIMITS,
	jobSettingsSchema,
	type Line,
	MAX_FRAME_BYTES,
	PROTOCOL_VERSION,
	parseAgentFrame,
	serialiseServerFrame,
} from "@/lib/link/protocol";

/**
 * The link carries traffic from machines outside the server's control, so these tests are
 * mostly about what the protocol *refuses*. A frame that parses when it should not is how a
 * hostile or faulty agent reaches the print path.
 */

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

function line(overrides: Partial<Line> = {}): Line {
	return {
		align: "LEFT",
		spans: [{ text: "Coffee", bold: false, underline: 0, invert: false, widthMult: 1, heightMult: 1, font: "A" }],
		directives: [],
		...overrides,
	};
}

describe("parseAgentFrame", () => {
	it("accepts a well-formed hello", () => {
		const result = parseAgentFrame(helloFrame());
		expect(result.ok).toBe(true);
	});

	it("rejects a frame larger than the cap before parsing it", () => {
		// The cap has to bite before JSON.parse, or an oversized frame is already in memory
		// by the time it is rejected.
		const oversized = JSON.stringify({ type: "hello", padding: "x".repeat(MAX_FRAME_BYTES) });
		const result = parseAgentFrame(oversized);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("too_large");
		}
	});

	it("rejects malformed JSON without throwing", () => {
		const result = parseAgentFrame("{ not json");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("invalid_json");
		}
	});

	it("rejects an unknown frame type", () => {
		const result = parseAgentFrame(JSON.stringify({ type: "shell.exec", command: "rm -rf /" }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.reason).toBe("invalid_frame");
		}
	});

	it("rejects a server-only frame arriving from a agent", () => {
		// A agent must not be able to instruct itself, or another agent, by echoing a frame the
		// server would normally originate.
		const result = parseAgentFrame(
			JSON.stringify({ type: "job.dispatch", job: { jobId: "x", device: "kitchen", linefeed: "LF", lines: [] } }),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects a hello with an over-long hostname", () => {
		expect(parseAgentFrame(helloFrame({ hostname: "h".repeat(256) })).ok).toBe(false);
	});

	it("rejects a hello missing a required field", () => {
		expect(parseAgentFrame(JSON.stringify({ type: "hello", protocolVersion: 1 })).ok).toBe(false);
	});

	it("accepts a job update and its optional metrics", () => {
		const result = parseAgentFrame(
			JSON.stringify({
				type: "job.update",
				jobId: "job-1",
				status: "COMPLETED",
				at: new Date().toISOString(),
				lines: 12,
				bytes: 418,
			}),
		);
		expect(result.ok).toBe(true);
	});

	it("rejects a job update carrying a status outside the domain set", () => {
		const result = parseAgentFrame(
			JSON.stringify({ type: "job.update", jobId: "job-1", status: "EXPLODED", at: new Date().toISOString() }),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects a job update with a non-ISO timestamp", () => {
		const result = parseAgentFrame(
			JSON.stringify({ type: "job.update", jobId: "job-1", status: "QUEUED", at: "yesterday" }),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects negative metrics", () => {
		const result = parseAgentFrame(
			JSON.stringify({
				type: "job.update",
				jobId: "job-1",
				status: "COMPLETED",
				at: new Date().toISOString(),
				bytes: -1,
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects an over-long error message rather than storing it", () => {
		const result = parseAgentFrame(
			JSON.stringify({
				type: "job.update",
				jobId: "job-1",
				status: "FAILED",
				at: new Date().toISOString(),
				errorMessage: "e".repeat(513),
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects a job identifier carrying anything but an identifier's characters", () => {
		// Identifiers are interpolated into log lines on both sides, and a log line is read by a
		// person at a terminal. A newline in one forges an entry; an escape sequence drives the
		// terminal. Device and asset names have been slugs for exactly this reason and identifiers
		// were the gap.
		const forged = parseAgentFrame(
			JSON.stringify({
				type: "job.update",
				jobId: "\x1b[31mFAKE\x1b[0m {RED}\nWARN forged",
				status: "FAILED",
				at: new Date().toISOString(),
			}),
		);
		expect(forged.ok).toBe(false);
	});

	it("accepts the identifiers this server actually issues", () => {
		const cuid = parseAgentFrame(
			JSON.stringify({
				type: "job.update",
				jobId: "cmtn7vj5r0001vcvhd59uswty",
				status: "COMPLETED",
				at: new Date().toISOString(),
			}),
		);
		expect(cuid.ok).toBe(true);
	});
});

describe("serialiseServerFrame", () => {
	it("serialises a dispatch", () => {
		const text = serialiseServerFrame({
			type: "job.dispatch",
			job: { jobId: "job-1", device: "kitchen", linefeed: "LF", lines: [line()] },
		});
		expect(JSON.parse(text)).toMatchObject({ type: "job.dispatch" });
	});

	/**
	 * The failure this prevents is not a rejected job — it is a dropped agent. `LinkClient.java`
	 * treats an oversized frame as a protocol violation and closes the link, so a single receipt that
	 * overran the cap would take every printer behind that agent offline. Refusing at the one point
	 * every outgoing frame passes through is what makes the write impossible rather than merely
	 * unlikely.
	 *
	 * Reachable without any of the per-field limits being broken: `maxTotalChars` is
	 * operator-configurable to a million characters, so a lawful receipt on such an install can
	 * compile to more than a frame will carry.
	 */
	it("refuses a frame larger than the cap rather than letting it reach the socket", () => {
		const thrown = (() => {
			try {
				serialiseServerFrame({
					type: "job.dispatch",
					job: {
						jobId: "job-1",
						device: "kitchen",
						linefeed: "LF",
						// Each line is a full-length span, so the cap is met with lawful lines rather
						// than by breaking any other limit.
						lines: Array.from({ length: 600 }, () =>
							line({
								spans: [
									{
										text: "x".repeat(JOB_LIMITS.maxSpanChars),
										bold: false,
										underline: 0,
										invert: false,
										widthMult: 1,
										heightMult: 1,
										font: "A",
									},
								],
							}),
						),
					},
				});
				return null;
			} catch (error) {
				return error;
			}
		})();

		expect(thrown).toBeInstanceOf(FrameTooLargeError);
		expect((thrown as FrameTooLargeError).bytes).toBeGreaterThan(MAX_FRAME_BYTES);
	});

	it("serialises a frame that only just fits", () => {
		// The edge matters in both directions: a guard that refused a legal frame would be a
		// different outage from the one it was added to prevent.
		const text = serialiseServerFrame({
			type: "job.dispatch",
			job: {
				jobId: "job-1",
				device: "kitchen",
				linefeed: "LF",
				lines: Array.from({ length: 400 }, () =>
					line({
						spans: [
							{
								text: "x".repeat(JOB_LIMITS.maxSpanChars),
								bold: false,
								underline: 0,
								invert: false,
								widthMult: 1,
								heightMult: 1,
								font: "A",
							},
						],
					}),
				),
			},
		});

		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
	});

	it("refuses to send a job exceeding the line cap", () => {
		// Caught here rather than by the agent, so the server never records as sent a job the
		// far side was always going to reject.
		expect(() =>
			serialiseServerFrame({
				type: "job.dispatch",
				job: {
					jobId: "job-1",
					device: "kitchen",
					linefeed: "LF",
					lines: Array.from({ length: JOB_LIMITS.maxLines + 1 }, () => line()),
				},
			}),
		).toThrow();
	});

	it("refuses a size multiplier outside the printer's range", () => {
		expect(() =>
			serialiseServerFrame({
				type: "job.dispatch",
				job: {
					jobId: "job-1",
					device: "kitchen",
					linefeed: "LF",
					lines: [
						line({
							spans: [{ text: "x", bold: false, underline: 0, invert: false, widthMult: 9, heightMult: 1, font: "A" }],
						}),
					],
				},
			}),
		).toThrow();
	});

	it("refuses a device name that would need escaping in a path or log", () => {
		expect(() =>
			serialiseServerFrame({
				type: "job.dispatch",
				job: { jobId: "job-1", device: "../../etc", linefeed: "LF", lines: [] },
			}),
		).toThrow();
	});

	it("refuses a feed beyond one byte", () => {
		expect(() =>
			serialiseServerFrame({
				type: "job.dispatch",
				job: {
					jobId: "job-1",
					device: "kitchen",
					linefeed: "LF",
					lines: [line({ spans: [], directives: [{ type: "FEED", lines: 256 }] })],
				},
			}),
		).toThrow();
	});

	it("round-trips a config sync", () => {
		const text = serialiseServerFrame({
			type: "config.sync",
			devices: [
				{
					name: "kitchen",
					port: "COM3",
					baudRate: 9600,
					dataBits: 8,
					stopBits: 1,
					parity: "NONE",
					flowControl: "NONE",
					writeTimeoutMs: 5000,
					autoConnect: true,
					autoReconnect: true,
					reconnectDelaySeconds: 5,
					columns: 42,
					codepage: "CP858",
					paused: false,
					maxQueueDepth: 100,
				},
			],
			assets: [],
		});
		expect(JSON.parse(text).devices[0].codepage).toBe("CP858");
	});
});

describe("configSyncSchema", () => {
	it("carries job settings when the server sends them", () => {
		const parsed = configSyncSchema.parse({
			type: "config.sync",
			devices: [],
			assets: [],
			jobs: { retentionMinutes: 1440, maxRecords: 10_000, shutdownGraceSeconds: 10 },
		});

		expect(parsed.jobs).toEqual({ retentionMinutes: 1440, maxRecords: 10_000, shutdownGraceSeconds: 10 });
	});

	it("accepts a frame with no job settings, so an older server still parses", () => {
		const parsed = configSyncSchema.parse({ type: "config.sync", devices: [], assets: [] });

		expect(parsed.jobs).toBeUndefined();
	});

	it("refuses job settings outside their bounds", () => {
		expect(() =>
			configSyncSchema.parse({
				type: "config.sync",
				devices: [],
				assets: [],
				jobs: { retentionMinutes: 0, maxRecords: 10_000, shutdownGraceSeconds: 10 },
			}),
		).toThrow();
	});

	it("carries agent settings when the server sends them", () => {
		const parsed = configSyncSchema.parse({
			type: "config.sync",
			devices: [],
			assets: [],
			agent: { statusIntervalSeconds: 45, evictionIntervalSeconds: 120, queuePollMs: 250 },
		});

		expect(parsed.agent).toEqual({ statusIntervalSeconds: 45, evictionIntervalSeconds: 120, queuePollMs: 250 });
	});

	it("accepts a frame with no agent settings, so an older server still parses", () => {
		const parsed = configSyncSchema.parse({ type: "config.sync", devices: [], assets: [] });

		expect(parsed.agent).toBeUndefined();
	});

	it("refuses agent settings outside their bounds", () => {
		expect(() =>
			configSyncSchema.parse({
				type: "config.sync",
				devices: [],
				assets: [],
				agent: { statusIntervalSeconds: 4, evictionIntervalSeconds: 120, queuePollMs: 250 },
			}),
		).toThrow();
	});
});

/**
 * Guards `jobSettingsSchema` and `agentSettingsSchema` against the bounds `FrameCodec`'s
 * `readJobSettings` and `readAgentSettings` restate on the agent.
 *
 * The duplication is deliberate — a receiver that trusted the sender's own validation would not
 * have validated anything — but it means the same names and numbers exist in two languages with
 * nothing keeping them in sync. A bound edited on one side only produces a settings value the
 * server accepts and the agent silently reinterprets, or refuses outright, so the Java source is
 * parsed and compared directly rather than trusting the two files to agree by inspection. Mirrors
 * the approach `test/lib/domain/enums.test.ts` takes against the Java enums.
 */
const FRAME_CODEC_DIR = fileURLToPath(
	new URL("../../../../agent/src/main/java/fi/natroutter/fenpos/link/", import.meta.url),
);

interface RestatedBound {
	min: number;
	max: number;
}

/**
 * Extracts the field names and bounds a private `FrameCodec` reader method restates from its
 * schema counterpart.
 *
 * Scoped to the method body rather than the whole file, so a `requireBoundedInt` call anywhere
 * else in `FrameCodec.java` — including the other reader this same file guards — cannot be
 * mistaken for one of this method's fields. Shared by the `jobSettingsSchema` and
 * `agentSettingsSchema` parity checks below, parameterised on the method's name and the name of
 * the `JsonObject` parameter its `requireBoundedInt` calls read from.
 *
 * @param methodName    the private static method to read, e.g. `readJobSettings`
 * @param parameterName the `JsonObject` parameter name that method's `requireBoundedInt` calls use
 */
function javaRestatedBounds(methodName: string, parameterName: string): Record<string, RestatedBound> {
	const source = readFileSync(join(FRAME_CODEC_DIR, "FrameCodec.java"), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");

	const signature = source.search(new RegExp(`private static \\w+ ${methodName}\\(`));
	if (signature === -1) {
		throw new Error(`${methodName} not found in FrameCodec.java`);
	}

	const bodyStart = source.indexOf("{", signature);
	let depth = 0;
	let bodyEnd = -1;
	for (let index = bodyStart; index < source.length; index++) {
		if (source[index] === "{") depth++;
		else if (source[index] === "}") {
			depth--;
			if (depth === 0) {
				bodyEnd = index;
				break;
			}
		}
	}
	if (bodyEnd === -1) {
		throw new Error(`${methodName} has no closing brace`);
	}
	const body = source.slice(bodyStart, bodyEnd);

	const bounds: Record<string, RestatedBound> = {};
	const pattern = new RegExp(
		`requireBoundedInt\\(\\s*${parameterName},\\s*"(\\w+)",\\s*([\\d_]+),\\s*([\\d_]+)\\s*\\)`,
		"g",
	);
	for (const match of body.matchAll(pattern)) {
		const [, field, min, max] = match;
		bounds[field] = { min: Number(min.replace(/_/g, "")), max: Number(max.replace(/_/g, "")) };
	}
	return bounds;
}

describe("job settings bounds match FrameCodec.readJobSettings", () => {
	const javaBounds = javaRestatedBounds("readJobSettings", "jobs");
	const tsFields = jobSettingsSchema.shape;

	it("restates exactly the three fields jobSettingsSchema declares", () => {
		expect(Object.keys(javaBounds).sort()).toEqual(Object.keys(tsFields).sort());
	});

	it.each(Object.keys(tsFields))("%s's bounds match between the schema and FrameCodec", (field) => {
		const tsField = tsFields[field as keyof typeof tsFields];
		const javaBound = javaBounds[field];

		expect(javaBound, `FrameCodec.readJobSettings does not restate "${field}"`).toBeDefined();
		expect(javaBound.min, `min for "${field}": schema says ${tsField.minValue}, FrameCodec says ${javaBound.min}`).toBe(
			tsField.minValue,
		);
		expect(javaBound.max, `max for "${field}": schema says ${tsField.maxValue}, FrameCodec says ${javaBound.max}`).toBe(
			tsField.maxValue,
		);
	});

	it("parses the known method correctly, so an empty result cannot pass silently", () => {
		// Without this, a regex that matched nothing would make the checks above vacuously pass
		// against an equally empty set.
		expect(javaBounds).toEqual({
			retentionMinutes: { min: 1, max: 40_320 },
			maxRecords: { min: 100, max: 1_000_000 },
			shutdownGraceSeconds: { min: 1, max: 300 },
		});
	});
});

/**
 * Guards `agentSettingsSchema` against the bounds `FrameCodec.readAgentSettings` restates on the
 * agent — the same parity check as above, applied to the three settings that ride the same frame.
 */
describe("agent settings bounds match FrameCodec.readAgentSettings", () => {
	const javaBounds = javaRestatedBounds("readAgentSettings", "agent");
	const tsFields = agentSettingsSchema.shape;

	it("restates exactly the three fields agentSettingsSchema declares", () => {
		expect(Object.keys(javaBounds).sort()).toEqual(Object.keys(tsFields).sort());
	});

	it.each(Object.keys(tsFields))("%s's bounds match between the schema and FrameCodec", (field) => {
		const tsField = tsFields[field as keyof typeof tsFields];
		const javaBound = javaBounds[field];

		expect(javaBound, `FrameCodec.readAgentSettings does not restate "${field}"`).toBeDefined();
		expect(javaBound.min, `min for "${field}": schema says ${tsField.minValue}, FrameCodec says ${javaBound.min}`).toBe(
			tsField.minValue,
		);
		expect(javaBound.max, `max for "${field}": schema says ${tsField.maxValue}, FrameCodec says ${javaBound.max}`).toBe(
			tsField.maxValue,
		);
	});

	it("parses the known method correctly, so an empty result cannot pass silently", () => {
		// Without this, a regex that matched nothing would make the checks above vacuously pass
		// against an equally empty set.
		expect(javaBounds).toEqual({
			statusIntervalSeconds: { min: 5, max: 300 },
			evictionIntervalSeconds: { min: 10, max: 3_600 },
			queuePollMs: { min: 20, max: 2_000 },
		});
	});
});

describe("block directives on the wire", () => {
	it("accepts a QR directive", () => {
		expect(directiveSchema.parse({ type: "QR", content: "https://x.test", size: 6 })).toMatchObject({ type: "QR" });
	});

	it("accepts a QR size at the low edge", () => {
		expect(directiveSchema.parse({ type: "QR", content: "x", size: 1 })).toMatchObject({ size: 1 });
	});

	it("accepts a QR size at the high edge", () => {
		expect(directiveSchema.parse({ type: "QR", content: "x", size: 16 })).toMatchObject({ size: 16 });
	});

	it("refuses a QR size below the low edge", () => {
		expect(() => directiveSchema.parse({ type: "QR", content: "x", size: 0 })).toThrow();
	});

	it("refuses a QR size above the high edge", () => {
		expect(() => directiveSchema.parse({ type: "QR", content: "x", size: 17 })).toThrow();
	});

	it("refuses a QR directive with empty content", () => {
		expect(() => directiveSchema.parse({ type: "QR", content: "", size: 6 })).toThrow();
	});

	it("accepts a barcode with a known symbology", () => {
		expect(directiveSchema.parse({ type: "BARCODE", system: "CODE128", content: "12345" })).toMatchObject({
			system: "CODE128",
		});
	});

	it("refuses an unknown symbology", () => {
		expect(() => directiveSchema.parse({ type: "BARCODE", system: "NOPE", content: "1" })).toThrow();
	});

	it("refuses a barcode directive with empty content", () => {
		expect(() => directiveSchema.parse({ type: "BARCODE", system: "CODE128", content: "" })).toThrow();
	});

	it("accepts a PDF417 directive", () => {
		expect(directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: 4, columns: 5 })).toMatchObject({
			type: "PDF417",
			content: "x",
			errorLevel: 4,
		});
	});

	it("accepts a PDF417 error level at the low edge", () => {
		expect(directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: 0, columns: 5 })).toMatchObject({
			errorLevel: 0,
		});
	});

	it("accepts a PDF417 error level at the high edge", () => {
		expect(directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: 8, columns: 5 })).toMatchObject({
			errorLevel: 8,
		});
	});

	it("refuses a PDF417 error level below the low edge", () => {
		expect(() => directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: -1, columns: 5 })).toThrow();
	});

	it("refuses a PDF417 error level above the high edge", () => {
		expect(() => directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: 9, columns: 5 })).toThrow();
	});

	/**
	 * The one piece of measured geometry on this schema, and it is required.
	 *
	 * Zero is refused rather than treated as a default because zero is exactly what `GS ( k`
	 * function 65 reads as "printer decides" — and a symbol the printer laid out is not the symbol
	 * the server charged a line budget for. A schema that made this optional, or that allowed zero,
	 * would let that state back onto the wire.
	 */
	it("requires a PDF417 column count inside what function 65 encodes", () => {
		expect(() => directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: 4 })).toThrow();
		expect(() => directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: 4, columns: 0 })).toThrow();
		expect(() => directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: 4, columns: 31 })).toThrow();
		expect(directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: 4, columns: 1 })).toMatchObject({
			columns: 1,
		});
		expect(directiveSchema.parse({ type: "PDF417", content: "x", errorLevel: 4, columns: 30 })).toMatchObject({
			columns: 30,
		});
	});

	it("refuses a PDF417 directive with empty content", () => {
		expect(() => directiveSchema.parse({ type: "PDF417", content: "", errorLevel: 4, columns: 5 })).toThrow();
	});

	it("accepts a drawer pulse on pin 2", () => {
		expect(directiveSchema.parse({ type: "DRAWER", pin: 2 })).toMatchObject({ pin: 2 });
	});

	it("accepts a drawer pulse on pin 5", () => {
		expect(directiveSchema.parse({ type: "DRAWER", pin: 5 })).toMatchObject({ pin: 5 });
	});

	it("refuses a drawer pin the hardware does not have", () => {
		expect(() => directiveSchema.parse({ type: "DRAWER", pin: 3 })).toThrow();
	});
});

describe("two-dimensional symbol content", () => {
	it("refuses a QR payload outside ASCII", () => {
		// The agent declares such a symbol's length in characters and sends it as UTF-8 bytes, so
		// one character above U+007F makes the two disagree and the printer reads a truncated
		// payload as a valid symbol. It scans, and it scans as the wrong thing.
		expect(directiveSchema.safeParse({ type: "QR", content: "hyvää", size: 4 }).success).toBe(false);
	});

	it("refuses a PDF417 payload outside ASCII", () => {
		expect(directiveSchema.safeParse({ type: "PDF417", content: "héllo", errorLevel: 2, columns: 6 }).success).toBe(
			false,
		);
	});

	it("accepts an ASCII payload", () => {
		expect(directiveSchema.safeParse({ type: "QR", content: "https://example.com", size: 4 }).success).toBe(true);
	});
});

describe("images on the wire", () => {
	/** A raster of the right size for its rectangle, all paper. */
	function bits(widthDots: number, heightDots: number): string {
		return Buffer.alloc(Math.ceil(widthDots / 8) * heightDots).toString("base64");
	}

	it("accepts an image naming a raster the agent was already sent", () => {
		expect(
			directiveSchema.parse({ type: "IMAGE", source: { kind: "REF", ref: "logo", widthDots: 384 } }),
		).toMatchObject({ type: "IMAGE", source: { kind: "REF", ref: "logo" } });
	});

	it("refuses a reference that is not a stored asset's name", () => {
		expect(() =>
			directiveSchema.parse({ type: "IMAGE", source: { kind: "REF", ref: "https://x.test/a.png", widthDots: 384 } }),
		).toThrow();
	});

	it("accepts an image carrying its own bits", () => {
		expect(
			directiveSchema.parse({
				type: "IMAGE",
				source: { kind: "INLINE", widthDots: 16, heightDots: 2, data: bits(16, 2) },
			}),
		).toMatchObject({ source: { kind: "INLINE", heightDots: 2 } });
	});

	/**
	 * The check that matters most on this schema. A raster whose bits do not fill its stated
	 * rectangle leaves the printer waiting for bytes that never arrive, which needs a power cycle
	 * rather than a failed job — so the count is checked where the frame is defined.
	 */
	it("refuses inline bits that do not fill the stated rectangle", () => {
		expect(() =>
			directiveSchema.parse({
				type: "IMAGE",
				source: { kind: "INLINE", widthDots: 16, heightDots: 2, data: bits(16, 3) },
			}),
		).toThrow();
	});

	it("counts a row's padding towards the rectangle", () => {
		// Nine dots across is two bytes a row, not one and an eighth.
		expect(() =>
			directiveSchema.parse({
				type: "IMAGE",
				source: { kind: "INLINE", widthDots: 9, heightDots: 4, data: Buffer.alloc(5).toString("base64") },
			}),
		).toThrow();
		expect(
			directiveSchema.parse({
				type: "IMAGE",
				source: { kind: "INLINE", widthDots: 9, heightDots: 4, data: bits(9, 4) },
			}),
		).toMatchObject({ source: { kind: "INLINE" } });
	});

	it("refuses an image source of neither kind", () => {
		expect(() => directiveSchema.parse({ type: "IMAGE", source: { kind: "SOMEDAY", ref: "logo" } })).toThrow();
	});

	/**
	 * The closest thing to a round trip that fits in one test runner: the exact text this side
	 * produces for four known bytes, which is the exact text `FrameCodecTest.readsTheRastersASnapshot
	 * Carries` on the agent parses back into those bytes. The two fixtures are deliberately the same
	 * string, so a change to the encoding on either side leaves the pair visibly disagreeing.
	 */
	it("encodes dots the way the agent's codec decodes them", () => {
		const text = serialiseServerFrame({
			type: "config.sync",
			devices: [],
			assets: [
				{
					name: "logo",
					widthDots: 16,
					heightDots: 2,
					data: Buffer.from([0x80, 0x01, 0x00, 0xff]).toString("base64"),
				},
			],
		});

		expect(JSON.parse(text).assets[0].data).toBe("gAEA/w==");
	});

	it("carries synced rasters on a config sync", () => {
		const text = serialiseServerFrame({
			type: "config.sync",
			devices: [],
			assets: [{ name: "logo", widthDots: 16, heightDots: 2, data: bits(16, 2) }],
		});
		expect(JSON.parse(text).assets[0].name).toBe("logo");
	});

	it("refuses a synced raster whose bits do not fill its rectangle", () => {
		expect(() =>
			serialiseServerFrame({
				type: "config.sync",
				devices: [],
				assets: [{ name: "logo", widthDots: 16, heightDots: 2, data: bits(16, 1) }],
			}),
		).toThrow();
	});

	it("refuses more synced rasters than the cap", () => {
		expect(() =>
			serialiseServerFrame({
				type: "config.sync",
				devices: [],
				assets: Array.from({ length: IMAGE_LIMITS.maxSyncedRasters + 1 }, () => ({
					name: "logo",
					widthDots: 8,
					heightDots: 1,
					data: bits(8, 1),
				})),
			}),
		).toThrow();
	});
});
