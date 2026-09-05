import { beforeEach, describe, expect, it } from "vitest";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { compilePreview, compilePreviewWithContext, faultOf } from "@/lib/jobs/preview";
import type { CompiledJob } from "@/lib/link/protocol";
import { type AgentLink, registerLink, unregisterLink } from "@/lib/link/registry";
import { createVariable } from "@/lib/variables/variable-service";

/**
 * Compiling markup without printing it.
 *
 * The property this file exists to pin is that a preview settles everything a print would and then
 * stops: the same wrapping, the same codepage rejections, the same limits — and no job row, no
 * agent, no paper. A preview that took a different path through the compiler would be a preview of
 * something the printer will not produce, which is worse than no preview at all.
 */

let deviceId: string;

beforeEach(async () => {
	await prisma.job.deleteMany();
	await prisma.deviceVariable.deleteMany();
	await prisma.variable.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	const device = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 20, codepage: "CP858" },
	});
	deviceId = device.id;
});

/** A `STATIC` definition with everything a static variable does not use already nulled out. */
const STATIC = {
	kind: "STATIC" as const,
	pattern: null,
	offsetAmount: null,
	offsetUnit: null,
	source: null,
	overridable: false,
	description: null,
};

describe("compilePreview", () => {
	it("returns the lines a print would produce", async () => {
		const result = await compilePreview(deviceId, { data: ["Total 5.50"] });

		expect(result.errors).toEqual([]);
		expect(result.lines).not.toBeNull();
		expect(result.lines?.[0].spans.map((span) => span.text).join("")).toBe("Total 5.50");
	});

	it("wraps to the device's width, not to some other number", async () => {
		const result = await compilePreview(deviceId, { data: ["A".repeat(30)] });

		expect(result.columns).toBe(20);
		expect(result.lines?.length).toBe(2);
	});

	it("reports the measurements a caller checks their receipt against", async () => {
		const result = await compilePreview(deviceId, { data: ["one", "two"] });

		expect(result.outputLines).toBeGreaterThan(0);
		expect(result.maxOutputLines).toBeGreaterThan(0);
		expect(result.linefeed).toBe("LF");
	});

	it("reports bad markup as an error carrying its position, and compiles nothing", async () => {
		const result = await compilePreview(deviceId, { data: ["<bold>unclosed"] });

		expect(result.lines).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].code).toBe("unclosed_tag");
		expect(result.errors[0].line).toBe(1);
	});

	it("reports every bad element, not only the first", async () => {
		const result = await compilePreview(deviceId, { data: ["<bold>a", "<nope>b</nope>"] });

		expect(result.errors.length).toBeGreaterThan(1);
	});

	it("reports a request-level failure without a line, because it belongs to the whole body", async () => {
		const result = await compilePreview(deviceId, { data: "not an array" });

		expect(result.errors[0].line).toBeNull();
	});

	it("creates no job row, ever", async () => {
		await compilePreview(deviceId, { data: ["Total 5.50"] });
		await compilePreview(deviceId, { data: ["<bold>unclosed"] });

		expect(await prisma.job.count()).toBe(0);
	});

	it("reports an unknown device as an error rather than throwing", async () => {
		const result = await compilePreview("no-such-device", { data: ["hi"] });

		expect(result.errors[0].code).toBe("unknown_device");
	});
});

/**
 * The variable stage of the preview pipeline.
 *
 * It sits between `readRequest` and the element checks, and the position is load-bearing in both
 * directions: `collectElementErrors` parses every element and `unknown_variable` is one of the
 * things it must be able to report, while `resolveImages` needs `<image>{logo}</image>` already
 * substituted before it can know what to fetch.
 */
describe("compilePreview with variables", () => {
	const textOf = (result: { lines: { spans: { text: string }[] }[] | null }): string =>
		(result.lines ?? []).map((line) => line.spans.map((span) => span.text).join("")).join("\n");

	it("substitutes a defined value", async () => {
		await createVariable({ ...STATIC, name: "phone", value: "010-1234" });

		const result = await compilePreview(deviceId, { data: ["Call {phone}"] });

		expect(result.errors).toEqual([]);
		expect(textOf(result)).toBe("Call 010-1234");
	});

	it("reports an unknown name as an element error, positioned like any other markup mistake", async () => {
		const result = await compilePreview(deviceId, { data: ["ok", "Call {phne}"] });

		expect(result.lines).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({ code: "unknown_variable", line: 2, column: 6, status: 422 });
	});

	it("substitutes a job-supplied value the caller sent with the body", async () => {
		const result = await compilePreview(deviceId, { data: ["Order {order_id}"], variables: { order_id: "1041" } });

		expect(textOf(result)).toBe("Order 1041");
	});

	/**
	 * The catch around the resolution stage, which nothing exercised before.
	 *
	 * `resolveVariables` refuses a job-supplied value for a variable this install has locked, and it
	 * does so by throwing rather than by returning a fault — so the preview has to translate it, and
	 * report it as the one thing wrong with the request rather than letting it escape as a 500.
	 */
	it("reports a refused resolution as a fault, having already read the request", async () => {
		await createVariable({ ...STATIC, name: "phone", value: "010-1234" });

		const { preview, request, settings } = await compilePreviewWithContext(deviceId, {
			data: ["Call {phone}"],
			variables: { phone: "999" },
		});

		expect(preview.errors).toHaveLength(1);
		expect(preview.errors[0].code).toBe("variable_not_overridable");
		expect(preview.lines).toBeNull();
		// The measurements are still honest, and `request` is present because `readRequest` did
		// succeed — which is how a caller tells how far this compile got.
		expect(preview.columns).toBe(20);
		expect(request).not.toBeNull();
		expect(settings).toBeNull();
	});

	/**
	 * A row `date-fns` cannot render is omitted from the map rather than thrown through, so the
	 * preview behaves exactly as the print path does: everything else still compiles.
	 */
	it("previews a receipt that names nothing dynamic even with an unrenderable variable defined", async () => {
		await prisma.variable.create({ data: { name: "bad_date", kind: "DATETIME", pattern: "YYYY-MM-DD" } });

		const result = await compilePreview(deviceId, { data: ["Total 5.50"] });

		expect(result.errors).toEqual([]);
		expect(textOf(result)).toBe("Total 5.50");
	});
});

/**
 * **The property the whole preview endpoint sells: a preview is a print, stopped one step short.**
 *
 * Written around an `API_KEY_NAME` variable on purpose, because that is where the two paths had
 * genuinely diverged:
 * `submitJob` looked the submitting key's name up, `compilePreview` hardcoded `apiKeyName: null`, and
 * the preview route authenticated a key and then did not pass it on. So a receipt using one previewed
 * blank and printed the key's name — and since the substituted span is a different length, the
 * wrapping and the reported `outputLines` could differ too, which is the approximation `preview.ts`'s
 * own header promises this is not.
 *
 * The markup is deliberately longer than the device is wide, so that a divergence shows up as a
 * different number of lines and not only as different text.
 */
describe("a preview and a print of the same markup", () => {
	let link: AgentLink | null = null;
	let lastJob: CompiledJob | null = null;

	beforeEach(async () => {
		if (link) {
			unregisterLink(link);
			link = null;
		}
		lastJob = null;

		const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId }, select: { agentId: true } });
		link = {
			agentId: device.agentId,
			agentName: "helsinki",
			connectedAt: new Date(),
			address: "203.0.113.10",
			pending: new Set<string>(),
			send(frame) {
				if (frame.type === "job.dispatch") {
					lastJob = frame.job;
				}
				return true;
			},
			close() {},
		};
		registerLink(link);
	});

	/**
	 * The compiled text of each printed line.
	 *
	 * Deliberately the one shape both sides describe identically: a preview returns `CompiledLine[]`
	 * and a dispatch hands the link a wire `Line[]`, and `compile` maps one to the other one for one
	 * and in order, so comparing the text of each line compares the two pipelines rather than two
	 * serialisations.
	 */
	const linesOf = (job: { lines: { spans: { text: string }[] }[] | null } | null): string[] =>
		(job?.lines ?? []).map((line) => line.spans.map((span) => span.text).join(""));

	it("produce the same lines, including what an API_KEY_NAME variable resolves to", async () => {
		const key = await prisma.apiKey.create({
			data: { name: "till-1", keyHash: hashSecret(`preview-${Date.now()}`), maskedHint: "abcd" },
			select: { id: true, name: true },
		});
		await createVariable({
			...STATIC,
			kind: "CONTEXT",
			name: "submitted_by",
			value: null,
			source: "API_KEY_NAME",
		});

		const body = { data: ["Submitted by {submitted_by} at the counter"] };

		const preview = await compilePreview(deviceId, body, key.name);
		await submitJob(deviceId, body, key.id);

		expect(preview.errors).toEqual([]);
		expect(linesOf(lastJob)).not.toEqual([]);
		expect(linesOf(preview)).toEqual(linesOf(lastJob));
		// Named rather than merely equal, so a future change that made both sides blank still fails.
		expect(linesOf(lastJob).join(" ")).toContain("till-1");
		expect(preview.outputLines).toBe(lastJob?.lines.length);
	});

	/** And the panel's own preview keeps the null, because no key submitted it — the same value a panel print uses. */
	it("resolves an API_KEY_NAME variable to nothing when the panel is asking", async () => {
		await createVariable({
			...STATIC,
			kind: "CONTEXT",
			name: "submitted_by",
			value: null,
			source: "API_KEY_NAME",
		});

		const preview = await compilePreview(deviceId, { data: ["by{submitted_by}!"] });
		await submitJob(deviceId, { data: ["by{submitted_by}!"] });

		expect(preview.lines?.[0].spans.map((span) => span.text).join("")).toBe("by!");
		expect(linesOf(lastJob)).toEqual(["by!"]);
	});

	/**
	 * The same property for a date the *caller* described rather than one the panel defines.
	 *
	 * A dynamic value travels a route nothing else does — read by `readRequest`, rendered by
	 * `resolveVariables` — and both endpoints have to take the same one. The pattern is deliberately
	 * `yyyy`: the two sides read the clock independently, milliseconds apart, so a pattern whose value
	 * changes at midnight would make this test fail once a year for a reason that has nothing to do
	 * with what it is checking.
	 *
	 * The markup is longer than the device is wide, so a divergence shows up as a different number of
	 * lines and not only as different text.
	 */
	it("produce the same lines for a date the request described", async () => {
		const body = {
			data: ["Return by {return_by} at the counter"],
			variables: { return_by: { pattern: "yyyy", offset: { amount: 1, unit: "DAYS" } } },
		};

		const preview = await compilePreview(deviceId, body);
		await submitJob(deviceId, body);

		expect(preview.errors).toEqual([]);
		expect(linesOf(lastJob)).not.toEqual([]);
		expect(linesOf(preview)).toEqual(linesOf(lastJob));
		// And it actually resolved, rather than both sides agreeing on an empty span.
		expect(linesOf(preview).join("")).toContain("Return by 2");
	});
});

describe("faultOf", () => {
	it("flattens an ApiError into the shape a preview reports", () => {
		const fault = faultOf(new ApiError("unknown_variable", "no such thing", { line: 2, column: 6 }));

		expect(fault).toEqual({ code: "unknown_variable", message: "no such thing", status: 422, line: 2, column: 6 });
	});

	it("reports no position when the error carries none, rather than inventing one", () => {
		const fault = faultOf(new ApiError("invalid_json", "nope"));

		expect(fault.line).toBeNull();
		expect(fault.column).toBeNull();
	});

	/**
	 * The rethrow, which is what routes a genuine fault to the outer handler instead of dressing it
	 * up as a caller's mistake. A `500` that says "check the server log" is the honest answer for
	 * something nobody anticipated; a `422` naming a line would be a lie about whose fault it is.
	 */
	it("rethrows anything that is not an ApiError", () => {
		const boom = new TypeError("not a request problem");

		expect(() => faultOf(boom)).toThrow(boom);
	});
});

/**
 * The outer handler, reached only by a throw nobody wrote a fault for.
 *
 * A device with zero columns is the narrowest way to provoke one: every content check passes, and
 * the wrapper then refuses a paper width it cannot lay anything out on. What matters is not the
 * `RangeError` itself but that the endpoint answers with an `internal_error` fault rather than
 * propagating — the preview route turns a throw into a non-2xx, and this is a `200` whose body says
 * the receipt did not compile.
 */
describe("an unexpected fault", () => {
	it("is reported as internal_error rather than escaping the preview", async () => {
		const agent = await prisma.agent.create({ data: { name: `broken-${Date.now()}` } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "misconfigured", port: "COM9", columns: 0 },
		});

		const result = await compilePreview(device.id, { data: ["anything"] });

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({ code: "internal_error", status: 500, line: null, column: null });
		expect(result.lines).toBeNull();
	});
});
