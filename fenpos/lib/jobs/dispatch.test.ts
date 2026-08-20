import { beforeEach, describe, expect, it } from "vitest";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { serialiseServerFrame } from "@/lib/link/protocol";
import { type AgentLink, registerLink, unregisterLink } from "@/lib/link/registry";

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
		expect((thrown as ApiError).status).toBe(400);
		// Nothing reached the link, which is the point: an agent handed this would have closed it.
		expect(sent).toHaveLength(0);

		const [job] = await prisma.job.findMany();
		expect(job).toMatchObject({ status: "FAILED", errorCode: "job_too_large" });
	});
});
