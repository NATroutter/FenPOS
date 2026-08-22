import { beforeEach, describe, expect, it } from "vitest";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { FrameTooLargeError, JOB_LIMITS, serialiseServerFrame } from "@/lib/link/protocol";
import { type AgentLink, registerLink, unregisterLink } from "@/lib/link/registry";
import { setSetting } from "@/lib/settings/settings-service";

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

		const job = await submitJob(deviceId, { data: ["Kahvi 2.50"] });

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

		const job = await submitJob(deviceId, { data: ["Kahvi 2.50", "Toinen rivi"] });

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

		const thrown = await submitJob(deviceId, { data: ["Kahvi 2.50"] }).then(
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
