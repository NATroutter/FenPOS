import { beforeEach, describe, expect, it } from "vitest";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import type { CompiledJob } from "@/lib/link/protocol";
import { FrameTooLargeError, JOB_LIMITS, serialiseServerFrame } from "@/lib/link/protocol";
import { type AgentLink, registerLink, unregisterLink } from "@/lib/link/registry";
import { setSetting } from "@/lib/settings/settings-service";
import { createVariable } from "@/lib/variables/variable-service";

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
		await prisma.setting.deleteMany({ where: { key: "jobs.maxErrorMessageChars" } });
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
		maxLines: 10_000,
		maxLineChars: 10_000,
		maxTotalChars: 1_000_000,
		maxOutputLines: 10_000,
	};

	it("dispatches a receipt that fits", async () => {
		const { deviceId, sent } = await connectedDevice();

		const job = await submitJob(deviceId, { data: ["Coffee 2.50"] });

		expect(job.lines).toBe(1);
		expect(sent).toHaveLength(1);
		expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "QUEUED" });
	});

	/**
	 * `lines` is written onto the row itself, not only handed back in the return value — a replay
	 * reads the row (see `lib/jobs/idempotency.ts`), and a retry arriving after a timeout but before
	 * the agent has rendered anything still needs to see the real count rather than `null`.
	 */
	it("records the compiled line count on the row, not only in the response", async () => {
		const { deviceId } = await connectedDevice();

		const job = await submitJob(deviceId, { data: ["Coffee 2.50", "Second line"] });

		const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
		expect(row.lines).toBe(job.lines);
	});

	it("refuses a receipt too large to send, and settles the job rather than leaving it queued", async () => {
		const { deviceId, sent } = await connectedDevice(LONG_RECEIPTS_ALLOWED);

		// Lawful under every limit above, and past what one frame carries once compiled.
		const data = Array.from({ length: 700 }, () => "x".repeat(500));

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
		const { deviceId, sent } = await connectedDevice(LONG_RECEIPTS_ALLOWED);
		const data = Array.from({ length: 700 }, () => "x".repeat(500));

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
		const data = Array.from({ length: JOB_LIMITS.maxLines + 100 }, () => "x");

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

		const thrown = await submitJob(deviceId, { data: ["Coffee 2.50"] }).then(
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

		const job = await submitJob(deviceId, { data: ["Call {phone}"] });

		expect(
			sentJob()
				?.lines[0].spans.map((span) => span.text)
				.join(""),
		).toBe("Call 010-1234567");
		expect(job.lines).toBe(1);
	});

	/**
	 * Not caught before the row exists, unlike the request-shape and image failures above it in this
	 * file: `unknown_variable` is raised by `parseMarkup` inside `compile`, and `compile` needs the
	 * job's own id — so, like every other markup content error (an unknown tag, an unclosed one), it
	 * can only be discovered once the row is there to fail. Settled the same way the wire's own
	 * refusals are settled below, rather than left `QUEUED`.
	 */
	it("refuses a job naming a variable that does not exist, and settles the job rather than leaving it queued", async () => {
		const deviceId = await connectedDevice();

		await expect(submitJob(deviceId, { data: ["{nope}"] })).rejects.toMatchObject({ code: "unknown_variable" });

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

		const job = await submitJob(deviceId, { data: ["Coffee 2.50"] });

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

		await expect(submitJob(deviceId, { data: ["Printed {bad_date}"] })).rejects.toMatchObject({
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
			data: ["Return by {return_by}"],
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
		await expect(submitJob(deviceId, { data: ["<image>{brand}</image>"] })).rejects.toMatchObject({
			message: expect.stringContaining("logo"),
		});
	});
});
