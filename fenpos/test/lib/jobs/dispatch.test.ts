import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAsset, fontFace } from "@/lib/assets/asset-service";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import type { CompiledJob } from "@/lib/link/protocol";
import {
	FrameTooLargeError,
	IMAGE_LIMITS,
	JOB_LIMITS,
	MAX_FRAME_BYTES,
	serialiseServerFrame,
} from "@/lib/link/protocol";
import { type AgentLink, registerLink, unregisterLink } from "@/lib/link/registry";
import { dotWidth, LINE_HEIGHT_DOTS } from "@/lib/markup/blocks";
import { resolveImages } from "@/lib/markup/resolve-images";
import { advanceOf, typefaceFor } from "@/lib/raster/fonts";
import { setSetting } from "@/lib/settings/settings-service";
import { createVariable } from "@/lib/variables/variable-service";

/** A real face, so a drawn line's rows can be sized from its own metrics rather than guessed. */
const FONT = readFileSync(path.join(process.cwd(), "public/fonts/DejaVuSansMono.ttf"));

/**
 * A spy rather than a stub: what these tests need to observe is whether the network stage was
 * *reached* at all, not fake its answer, so every real call still resolves real images the way the
 * rest of this file expects.
 */
vi.mock("@/lib/markup/resolve-images", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/markup/resolve-images")>();
	return { ...actual, resolveImages: vi.fn(actual.resolveImages) };
});

/**
 * A second spy underneath the first: `resolveImages` is always invoked on the dispatch path, so an
 * unparsable receipt cannot prove it costs no network traffic by going uncalled the way an
 * over-the-limit one does. What it can prove is that it never gets as far as fetching — `collect` in
 * `resolve-images.ts` skips a document that does not parse — so this counts the fetch itself.
 */
const fetchRemoteImage = vi.hoisted(() => vi.fn<(url: string) => Promise<Buffer>>());

vi.mock("@/lib/assets/fetch-remote", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/assets/fetch-remote")>()),
	fetchRemoteImage,
}));

/**
 * The one dispatch failure that costs more than the job it belongs to.
 *
 * A receipt that compiles past `MAX_FRAME_BYTES` used to be recorded `QUEUED` and then written to
 * the socket, and the agent closes the link on an oversized frame — so one receipt took every
 * printer behind that agent offline until it reconnected. It is reachable without breaking any
 * per-field limit, because `maxTotalChars` is operator-configurable up to a million characters.
 *
 * The link registered here calls `serialiseServerFrame` and returns, which is precisely what the
 * real `AgentLink.send` in `agent-connection.ts` does with the frame before touching the socket. The
 * guard being exercised lives inside that call; what this file adds is that the refusal reaches the
 * caller as a 400 with the job settled, rather than as a 500 with a job stuck at `QUEUED`.
 */
describe("submitJob", () => {
	let link: AgentLink | null = null;

	beforeEach(async () => {
		if (link) {
			unregisterLink(link);
			link = null;
		}
		await prisma.job.deleteMany();
		await prisma.device.deleteMany();
		await prisma.agent.deleteMany();
		await prisma.asset.deleteMany();
		await prisma.setting.deleteMany({ where: { key: "jobs.maxErrorMessageChars" } });
		vi.mocked(resolveImages).mockClear();
		fetchRemoteImage.mockClear();
	});

	/**
	 * Creates an agent with one device, and registers a connection that serialises as the real one
	 * does.
	 *
	 * The limits are set on the device rather than through the install-wide settings, which reach the
	 * same three-layer lookup in `submitJob`. Settings are one shared row set and other files clear
	 * them in their own hooks, so writing them here would make two test files race over one table;
	 * a device belongs to this test and is deleted with it.
	 *
	 * @param limits per-device overrides, for the case that needs long receipts allowed
	 * @returns the device to print on, and a record of what reached the link
	 */
	async function connectedDevice(limits: Record<string, number> = {}): Promise<{
		deviceId: string;
		sent: number[];
	}> {
		const agent = await prisma.agent.create({
			data: { name: "kitchen", tokenHash: hashSecret("t"), status: "ONLINE" },
			select: { id: true },
		});
		const device = await prisma.device.create({
			// Wrapping off, so the receipt below stays the number of lines it says it is rather than
			// expanding past what the wire schema permits before its size is ever measured.
			data: { agentId: agent.id, name: "till", port: "COM3", defaultWrap: false, ...limits },
			select: { id: true },
		});

		const sent: number[] = [];
		link = {
			agentId: agent.id,
			agentName: "kitchen",
			connectedAt: new Date(),
			address: "203.0.113.10",
			pending: new Set<string>(),
			send(frame) {
				sent.push(serialiseServerFrame(frame).length);
				return true;
			},
			close() {},
		};
		registerLink(link);

		return { deviceId: device.id, sent };
	}

	/**
	 * Every content limit raised out of the way, as an install that prints long receipts would.
	 *
	 * Each of these is operator-configurable to at least this value — `maxTotalChars` to a million —
	 * which is exactly why the frame guard has to exist: none of them bound the compiled frame.
	 */
	const LONG_RECEIPTS_ALLOWED = {
		maxLineChars: 10_000,
		maxTotalChars: 1_000_000,
		maxOutputLines: 10_000,
	};

	/**
	 * A receipt that compiles past `MAX_FRAME_BYTES` without any one line tripping
	 * `IMAGE_LIMITS.maxRasterChars` or `IMAGE_LIMITS.maxHeightDots` on its own, and the device
	 * overrides it needs to reach `link.send` at all.
	 *
	 * **Several drawn lines rather than one long line of text.** Both of those per-raster caps sit
	 * comfortably under what a whole job's frame allows — that is what lets an operator's
	 * `limits.maxRasterMb` sit under `MAX_FRAME_BYTES` and still leave room for the job's own JSON —
	 * so no one drawn line can carry this on its own; the frame guard is only reachable by a job
	 * whose several rasters add up past it together. Sized off the face's own metrics —
	 * `typeface.cellHeight`, and the advance of the character actually drawn — rather than a row
	 * count guessed to overshoot whatever the caps happen to be today.
	 *
	 * @param assetName the stored font this receipt names
	 * @param columns the device's width, which fixes the paper a drawn line is canvassed onto
	 * @returns the receipt, and the `maxOutputLines`/`maxRasterMb` overrides it needs
	 */
	async function oversizedFontReceipt(
		assetName: string,
		columns: number,
	): Promise<{ data: string; maxOutputLines: number; maxRasterMb: number }> {
		const face = await fontFace(assetName);
		const size = 500;
		const typeface = typefaceFor(face, size);
		const widthDots = dotWidth(columns);
		const rowBytes = Math.ceil(widthDots / 8);
		const advance = advanceOf(typeface, "A".codePointAt(0) ?? 65) || 1;
		const charsPerRow = Math.max(1, Math.floor(widthDots / advance));

		// Whichever of the wire's two per-raster caps binds first on this device's paper: half of
		// what `maxRasterChars` allows as bytes, or nine tenths of what `maxHeightDots` allows as
		// rows, so no single line trips either on its own.
		const rowsByBytes = Math.ceil(
			Math.floor((IMAGE_LIMITS.maxRasterChars * 3) / 4 / 2) / rowBytes / typeface.cellHeight,
		);
		const rowsByHeight = Math.floor((IMAGE_LIMITS.maxHeightDots * 0.9) / typeface.cellHeight);
		const rowsPerLine = Math.max(1, Math.min(rowsByBytes, rowsByHeight));

		const charsPerLine = rowsPerLine * charsPerRow;
		const heightDotsPerLine = rowsPerLine * typeface.cellHeight;
		const heightLinesPerLine = Math.ceil(heightDotsPerLine / LINE_HEIGHT_DOTS);
		const rawBytesPerLine = rowBytes * heightDotsPerLine;

		// Enough lines that the base64 they carry clears MAX_FRAME_BYTES, with one whole line of
		// margin folded in.
		const lineCount = Math.max(2, Math.ceil((MAX_FRAME_BYTES * 3) / 4 / rawBytesPerLine) + 1);

		// Wrapped explicitly: `connectedDevice` turns the device's own `defaultWrap` off, and an
		// unwrapped drawn line stays one row however long its text is.
		const line = `<wrap><text font=${assetName} size=${size}>${"A".repeat(charsPerLine)}</text></wrap>`;

		return {
			data: Array.from({ length: lineCount }, () => line).join("\n"),
			maxOutputLines: heightLinesPerLine * lineCount + 10,
			maxRasterMb: Math.ceil((rawBytesPerLine * lineCount) / (1024 * 1024)) + 5,
		};
	}

	it("dispatches a receipt that fits", async () => {
		const { deviceId, sent } = await connectedDevice();

		const job = await submitJob(deviceId, { data: "Coffee 2.50" });

		expect(job.lines).toBe(1);
		expect(sent).toHaveLength(1);
		expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "QUEUED" });
	});

	/**
	 * The property the header comment above promises: a document refused for being over its own
	 * character limit must not cost a fetch. `requireDocumentWithinLimits` runs ahead of
	 * `resolveImages` precisely so that a `line_too_long` receipt never reaches it — proven here by
	 * the spy never being called, not merely by the refusal arriving.
	 */
	it("refuses a line_too_long document without ever calling resolveImages", async () => {
		const { deviceId } = await connectedDevice({ maxLineChars: 5 });

		const thrown = await submitJob(deviceId, { data: "this line is too long" }).then(
			() => null,
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).code).toBe("line_too_long");
		expect(resolveImages).not.toHaveBeenCalled();
		expect(await prisma.job.count()).toBe(0);
	});

	/**
	 * The other half of that same property, for a receipt that does not parse at all rather than one
	 * that is merely over budget. `requireDocumentWithinLimits` stays silent about the parse failure
	 * itself — see its own doc comment — so this receipt sails past it and reaches `resolveImages`,
	 * unlike the `line_too_long` case above: the row still gets created, and `compile` is what
	 * discovers the unclosed tag and settles it `FAILED`, exactly as any other markup content error
	 * does. What must still not happen is a fetch — the image reference sits inside the unclosed
	 * scope, and `collect` in `resolve-images.ts` skips a document that does not parse, so it is never
	 * found and never fetched.
	 */
	it("reaches a job row for an unparsable receipt, without ever fetching the image inside it", async () => {
		const { deviceId } = await connectedDevice();

		const thrown = await submitJob(deviceId, { data: "<bold><image>https://x.test/logo.png</image>" }).then(
			() => null,
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).code).toBe("unclosed_tag");
		// Reached, unlike the over-the-limit case above — proving the row really does get created —
		// but the fetch inside it never runs, which is the guarantee actually worth pinning here.
		expect(resolveImages).toHaveBeenCalledTimes(1);
		expect(fetchRemoteImage).not.toHaveBeenCalled();

		const [job] = await prisma.job.findMany();
		expect(job).toMatchObject({ status: "FAILED", errorCode: "unclosed_tag" });
	});

	/**
	 * `lines` is written onto the row itself, not only handed back in the return value — a replay
	 * reads the row (see `lib/jobs/idempotency.ts`), and a retry arriving after a timeout but before
	 * the agent has rendered anything still needs to see the real count rather than `null`.
	 */
	it("records the compiled line count on the row, not only in the response", async () => {
		const { deviceId } = await connectedDevice();

		const job = await submitJob(deviceId, { data: "Coffee 2.50\nSecond line" });

		const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
		expect(row.lines).toBe(job.lines);
	});

	it("refuses a receipt too large to send, and settles the job rather than leaving it queued", async () => {
		const FONT_ASSET = "dispatch-mono";
		await createAsset(FONT_ASSET, FONT);
		const { data, maxOutputLines, maxRasterMb } = await oversizedFontReceipt(FONT_ASSET, 42);

		// Lawful under every limit above, and past what one frame carries once compiled.
		const { deviceId, sent } = await connectedDevice({ ...LONG_RECEIPTS_ALLOWED, maxOutputLines, maxRasterMb });

		const thrown = await submitJob(deviceId, { data }).then(
			() => null,
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).code).toBe("job_too_large");
		expect((thrown as ApiError).status).toBe(413);
		// Nothing reached the link, which is the point: an agent handed this would have closed it.
		expect(sent).toHaveLength(0);

		const [job] = await prisma.job.findMany();
		expect(job).toMatchObject({ status: "FAILED", errorCode: "job_too_large" });
	});

	/**
	 * A job that never reaches an agent must not keep its caller's key locked up: a retry with the
	 * identical body should re-validate and dispatch fresh rather than replay a `202 QUEUED` for a
	 * job that will never print, and a retry with a corrected body should not be told it conflicts
	 * with a submission that never happened.
	 */
	it("frees the idempotency key when a job fails before reaching the agent", async () => {
		const FONT_ASSET = "dispatch-mono";
		await createAsset(FONT_ASSET, FONT);
		const { data, maxOutputLines, maxRasterMb } = await oversizedFontReceipt(FONT_ASSET, 42);
		const { deviceId, sent } = await connectedDevice({ ...LONG_RECEIPTS_ALLOWED, maxOutputLines, maxRasterMb });

		await submitJob(deviceId, { data }, null, { key: "order-1", hash: "hash-a" }).then(
			() => null,
			(error: unknown) => error,
		);

		expect(sent).toHaveLength(0);
		const [job] = await prisma.job.findMany();
		expect(job.status).toBe("FAILED");
		expect(job.idempotencyKey).toBeNull();
		expect(job.idempotencyHash).toBeNull();
	});

	/**
	 * The same outcome for a throw nobody enumerated, which is the actual fix.
	 *
	 * `JOB_LIMITS.maxLines` is 1000 and `maxOutputLines` is operator-configurable to 10,000, so a
	 * receipt between the two passes every content check, is recorded as a job, and is then refused
	 * by the wire schema — a `ZodError`, not a `FrameTooLargeError`. The handler used to settle only
	 * the second and rethrow everything else past itself, so the caller got a 500 and the job sat
	 * `QUEUED` forever. It is the same shape as the oversized inline raster the resolver now refuses
	 * up front; enumerating error types was the mistake in both.
	 *
	 * Asserted on the row rather than on the thrown error, because it is the row that was wrong.
	 */
	it("settles a job the wire refuses for a reason nobody enumerated", async () => {
		const { deviceId, sent } = await connectedDevice(LONG_RECEIPTS_ALLOWED);

		// Past the wire's 1000-line cap, inside this device's 10,000-line one, and small enough that
		// the frame guard is not what refuses it.
		const data = Array.from({ length: JOB_LIMITS.maxLines + 100 }, () => "x").join("\n");

		const thrown = await submitJob(deviceId, { data }).then(
			() => null,
			(error: unknown) => error,
		);

		expect(thrown).not.toBeNull();
		expect(thrown).not.toBeInstanceOf(FrameTooLargeError);
		expect(sent).toHaveLength(0);

		const [job] = await prisma.job.findMany();
		expect(job.status, "a job the wire refused must not be left QUEUED").toBe("FAILED");
		expect(job.errorCode).toBe("job_undeliverable");
		expect(job.errorMessage?.length ?? 0).toBeLessThanOrEqual(512);
	});

	/**
	 * `jobs.maxErrorMessageChars`, wired into `message()` (`dispatch.ts`).
	 *
	 * The link's `send` is made to throw an error long enough that truncation is guaranteed to
	 * bite regardless of the configured length, so the stored length is a direct readout of the
	 * setting rather than an accident of some other error's own wording.
	 */
	it("truncates a failed job's stored reason at the configured length rather than the built-in one", async () => {
		// 128 is jobs.maxErrorMessageChars's declared minimum.
		await setSetting("jobs.maxErrorMessageChars", 128);
		const { deviceId } = await connectedDevice();
		if (!link) {
			throw new Error("expected connectedDevice to have registered a link");
		}
		link.send = () => {
			throw new Error("x".repeat(1000));
		};

		const thrown = await submitJob(deviceId, { data: "Coffee 2.50" }).then(
			() => null,
			(error: unknown) => error,
		);

		expect(thrown).not.toBeNull();
		const [job] = await prisma.job.findMany();
		expect(job.status).toBe("FAILED");
		// Exactly 128: 127 characters of the original message plus the truncation ellipsis —
		// less than the built-in 512 default would have kept, so this is the setting's effect
		// and not merely a length that happens to fit under both.
		expect(job.errorMessage).toHaveLength(128);
	});
});

/**
 * Variables resolved and substituted on the dispatch path.
 *
 * The property worth pinning here is the ordering: `resolveVariables` has to run before
 * `resolveImages`, because an `<image>` reference can itself be a variable. A dispatch that got this
 * backwards would fail an `<image>{brand}</image>` as an unknown image reference literally named
 * `{brand}`, rather than resolving the name first and only then discovering whether that name is a
 * known image.
 */
describe("dispatch with variables", () => {
	let link: AgentLink | null = null;
	let lastJob: CompiledJob | null = null;

	beforeEach(async () => {
		if (link) {
			unregisterLink(link);
			link = null;
		}
		lastJob = null;
		await prisma.job.deleteMany();
		await prisma.deviceVariable.deleteMany();
		await prisma.variable.deleteMany();
		await prisma.device.deleteMany();
		await prisma.agent.deleteMany();
	});

	/** The last job handed to `link.send`, or null if none was sent yet this test. */
	const sentJob = () => lastJob;

	/** Creates an agent with one connected device, recording whatever job it is sent. */
	async function connectedDevice(): Promise<string> {
		const agent = await prisma.agent.create({
			data: { name: "kitchen", tokenHash: hashSecret("t"), status: "ONLINE" },
			select: { id: true },
		});
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "till", port: "COM3", defaultWrap: false },
			select: { id: true },
		});

		link = {
			agentId: agent.id,
			agentName: "kitchen",
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

		return device.id;
	}

	const STATIC = {
		kind: "STATIC" as const,
		pattern: null,
		offsetAmount: null,
		offsetUnit: null,
		source: null,
		overridable: false,
		description: null,
	};

	it("substitutes an install-wide value into a submitted job", async () => {
		const deviceId = await connectedDevice();
		await createVariable({ ...STATIC, name: "phone", value: "010-1234567" });

		const job = await submitJob(deviceId, { data: "Call {phone}" });

		expect(
			sentJob()
				?.lines[0].spans.map((span) => span.text)
				.join(""),
		).toBe("Call 010-1234567");
		expect(job.lines).toBe(1);
	});

	/**
	 * Not caught before the row exists, unlike the request-shape and image failures above it in this
	 * file: `unknown_variable` is raised while parsing inside `compile`, and `compile` needs the
	 * job's own id — so, like every other markup content error (an unknown tag, an unclosed one), it
	 * can only be discovered once the row is there to fail. Settled the same way the wire's own
	 * refusals are settled below, rather than left `QUEUED`.
	 */
	it("refuses a job naming a variable that does not exist, and settles the job rather than leaving it queued", async () => {
		const deviceId = await connectedDevice();

		await expect(submitJob(deviceId, { data: "{nope}" })).rejects.toMatchObject({ code: "unknown_variable" });

		const [job] = await prisma.job.findMany();
		expect(job).toMatchObject({ status: "FAILED", errorCode: "unknown_variable" });
	});

	/**
	 * **The containment property, at the level where it actually mattered.**
	 *
	 * `resolveVariables` evaluates every defined variable on every job, whether or not the receipt
	 * names one. A `DATETIME` row whose pattern `date-fns` refuses — `YYYY` and `DD` being the two
	 * an operator is most likely to type — therefore threw out of `resolveVariables`, out of
	 * `submitJob`, and reached the caller as an opaque `500 internal_error`. On every printer, for
	 * every key, for every receipt on the install, including receipts like this one that mention
	 * nothing dynamic at all. No job row was created, so the panel's job list showed nothing either.
	 *
	 * The row is written straight through Prisma because `createVariable` now refuses to store one —
	 * which is the other half of the fix, and is why this is about rows that got in some other way.
	 */
	it("prints a receipt that names nothing dynamic, even with an unrenderable variable in the table", async () => {
		const deviceId = await connectedDevice();
		await prisma.variable.create({ data: { name: "bad_date", kind: "DATETIME", pattern: "YYYY-MM-DD" } });

		const job = await submitJob(deviceId, { data: "Coffee 2.50" });

		expect(job.lines).toBe(1);
		expect(
			sentJob()
				?.lines[0].spans.map((span) => span.text)
				.join(""),
		).toBe("Coffee 2.50");
	});

	/** And the receipt that does name it fails as a markup error naming it, not as a 500 about nothing. */
	it("fails only the receipt that references the unrenderable variable, as unknown_variable", async () => {
		const deviceId = await connectedDevice();
		await prisma.variable.create({ data: { name: "bad_date", kind: "DATETIME", pattern: "YYYY-MM-DD" } });

		await expect(submitJob(deviceId, { data: "Printed {bad_date}" })).rejects.toMatchObject({
			code: "unknown_variable",
			status: 422,
		});
	});

	/**
	 * A malformed `variables` object is caught by `readRequest`, inside `submitJob` but before
	 * `job.create` runs — see the ordering `dispatch.ts`'s own header lays out. Pinned at this level
	 * rather than through the route: `test/app/api/v1/print/[agent]/[device]/route.test.ts` mocks
	 * `submitJob` entirely for its own reasons (its header explains why — the header check alone is
	 * what those tests are about), so it never reaches this validation and cannot exercise the
	 * no-row property. That property is what decides whether an `Idempotency-Key` stays free for a
	 * corrected retry: a request that never became a job must leave its key exactly as free as one
	 * that did not exist.
	 */
	it("refuses an object-valued variable that fails validation before any job row exists", async () => {
		const deviceId = await connectedDevice();

		const thrown = await submitJob(deviceId, {
			data: "Return by {return_by}",
			variables: { return_by: { pattern: "" } },
		}).then(
			() => null,
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).code).toBe("invalid_variable");
		expect(await prisma.job.count()).toBe(0);
	});

	it("resolves a variable inside an image reference", async () => {
		const deviceId = await connectedDevice();
		await createVariable({ ...STATIC, name: "brand", value: "logo" });

		// Fails as an unknown asset, not as an unknown image reference named "{brand}" — which is what
		// proves resolveVariables ran before resolveImages.
		await expect(submitJob(deviceId, { data: "<image>{brand}</image>" })).rejects.toMatchObject({
			message: expect.stringContaining("logo"),
		});
	});
});
