import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { settleUnfinishedJobs } from "@/lib/jobs/settle";
import { queueJobSettled } from "@/lib/webhooks/notify";

/**
 * The write both settle paths share.
 *
 * Exercised directly rather than only through them, because the cases that matter cannot be staged
 * from outside. A caller hands over ids it selected as unfinished and one of them has finished by
 * the time the write runs: handing this function an id that is already terminal is exactly that
 * situation, without having to win a race to reproduce it. And a write that fails half way through a
 * backlog is the database refusing a statement, which is reachable here and nowhere above here.
 *
 * The announcement is stubbed because whether a job was announced is the property under test, and
 * the real one does nothing at all unless webhooks are configured — which would make the assertions
 * below pass for the wrong reason.
 */
vi.mock("@/lib/webhooks/notify", () => ({ queueJobSettled: vi.fn(async () => {}) }));

describe("settleUnfinishedJobs", () => {
	let agentId: string;
	let deviceId: string;

	beforeEach(async () => {
		vi.mocked(queueJobSettled).mockClear();
		await prisma.job.deleteMany({});
		await prisma.agent.deleteMany({});

		const agent = await prisma.agent.create({ data: { name: "kitchen", tokenHash: "hash" }, select: { id: true } });
		agentId = agent.id;
		const device = await prisma.device.create({
			data: { agentId, name: "printer", port: "COM1" },
			select: { id: true },
		});
		deviceId = device.id;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Creates a job in the given state and returns its id. */
	async function jobIn(status: string, overrides: Record<string, unknown> = {}): Promise<string> {
		const job = await prisma.job.create({
			data: { agentId, deviceId, status, ...overrides },
			select: { id: true },
		});
		return job.id;
	}

	/** The job ids handed to the announcement, in the order they were announced. */
	function announced(): string[] {
		return vi.mocked(queueJobSettled).mock.calls.map(([jobId]) => jobId);
	}

	const failure = { errorCode: "agent_unpaired", errorMessage: "The agent was unpaired before this job finished." };

	it("fails the jobs that are still unfinished, announces them, and names them back", async () => {
		const queued = await jobIn("QUEUED");
		const printing = await jobIn("PRINTING");

		const settled = await settleUnfinishedJobs([queued, printing], failure);

		expect(settled.toSorted()).toEqual([queued, printing].toSorted());
		expect(announced().toSorted()).toEqual([queued, printing].toSorted());
		const rows = await prisma.job.findMany({ where: { id: { in: [queued, printing] } } });
		for (const row of rows) {
			expect(row.status).toBe("FAILED");
			expect(row.errorCode).toBe("agent_unpaired");
			expect(row.finishedAt).not.toBeNull();
		}
	});

	it("leaves a job that finished since it was selected exactly as it finished", async () => {
		// The one that corrupts a receipt. The agent is still connected and still reporting while a
		// settle runs, so a job can complete between the selection and the write; an update addressed
		// on id alone would rewrite that COMPLETED row as FAILED and hand a webhook subscriber a
		// second, contradicting answer for a receipt that printed.
		const completed = await jobIn("COMPLETED", { finishedAt: new Date(Date.now() - 60_000), lines: 12 });
		const queued = await jobIn("QUEUED");

		const settled = await settleUnfinishedJobs([completed, queued], failure);

		expect(settled).toEqual([queued]);
		expect(announced()).toEqual([queued]);
		const row = await prisma.job.findUniqueOrThrow({ where: { id: completed } });
		expect(row.status).toBe("COMPLETED");
		expect(row.errorCode).toBeNull();
	});

	it("names back nothing and announces nothing when every job was already settled", async () => {
		// Answered by someone else while this call was on its way. Nothing to write, and nothing to
		// tell a subscriber that it has not already been told.
		const first = await jobIn("COMPLETED", { finishedAt: new Date() });
		const second = await jobIn("CANCELLED", { finishedAt: new Date() });

		expect(await settleUnfinishedJobs([first, second], failure)).toEqual([]);
		expect(announced()).toEqual([]);
	});

	it("settles a backlog larger than one statement may bind", async () => {
		// A job is rowed as QUEUED whether or not its agent is reachable, so a long outage leaves a
		// backlog with no ceiling while SQLite caps how many parameters one statement may bind.
		// Addressing the whole backlog at once threw, and threw on precisely the agent that most
		// needed the repair.
		const ids: string[] = [];
		for (let index = 0; index < 250; index++) {
			ids.push(await jobIn("QUEUED"));
		}

		const settled = await settleUnfinishedJobs(ids, failure);

		expect(settled).toHaveLength(ids.length);
		expect(announced()).toHaveLength(ids.length);
		expect(await prisma.job.count({ where: { status: "FAILED" } })).toBe(ids.length);
	});

	it("announces every job it wrote even when a later batch fails", async () => {
		// A job written FAILED and not announced can never be recovered: both callers select what is
		// still unfinished, and this has just made it finished. So each batch is announced before the
		// next is attempted, rather than the whole set at the end — where one throw would take the ids
		// of everything already written down with it, unannounced and unreachable.
		const ids: string[] = [];
		for (let index = 0; index < 150; index++) {
			ids.push(await jobIn("QUEUED"));
		}

		// The second batch is refused, which is how a statement the database will not accept presents.
		const real = prisma.$transaction.bind(prisma) as (work: unknown) => Promise<unknown>;
		let batches = 0;
		vi.spyOn(prisma, "$transaction").mockImplementation(((work: unknown) => {
			batches += 1;
			return batches === 2 ? Promise.reject(new Error("too many SQL variables")) : real(work);
		}) as never);

		await expect(settleUnfinishedJobs(ids, failure)).rejects.toThrow(/too many SQL variables/);

		const written = await prisma.job.findMany({ where: { status: "FAILED" }, select: { id: true } });
		expect(written).toHaveLength(100);
		expect(announced().toSorted()).toEqual(written.map((job) => job.id).toSorted());

		// And what it never reached is untouched, so the caller that runs again still finds it.
		expect(await prisma.job.count({ where: { status: "QUEUED" } })).toBe(50);
	});
});
