import { describe, expect, it } from "vitest";
import {
	directiveSchema,
	JOB_LIMITS,
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
		spans: [{ text: "Kahvi", bold: false, underline: 0, invert: false, widthMult: 1, heightMult: 1, font: "A" }],
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
});

describe("serialiseServerFrame", () => {
	it("serialises a dispatch", () => {
		const text = serialiseServerFrame({
			type: "job.dispatch",
			job: { jobId: "job-1", device: "kitchen", linefeed: "LF", lines: [line()] },
		});
		expect(JSON.parse(text)).toMatchObject({ type: "job.dispatch" });
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
		});
		expect(JSON.parse(text).devices[0].codepage).toBe("CP858");
	});
});

describe("block directives on the wire", () => {
	it("accepts a QR directive", () => {
		expect(directiveSchema.parse({ type: "QR", content: "https://x.test", size: 6 })).toMatchObject({ type: "QR" });
	});

	it("accepts a drawer pulse", () => {
		expect(directiveSchema.parse({ type: "DRAWER", pin: 5 })).toMatchObject({ pin: 5 });
	});

	it("refuses a drawer pin the hardware does not have", () => {
		expect(() => directiveSchema.parse({ type: "DRAWER", pin: 3 })).toThrow();
	});

	it("refuses an unknown symbology", () => {
		expect(() => directiveSchema.parse({ type: "BARCODE", system: "NOPE", content: "1" })).toThrow();
	});
});
