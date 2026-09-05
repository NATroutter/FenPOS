import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { failUnfinishedJobs } from "@/lib/jobs/settle";

/**
 * The write both settle paths share.
 *
 * Exercised directly rather than only through them, because the case that matters cannot be staged
 * from outside: a caller hands over ids it selected as unfinished, and by the time the write runs
 * one of them has finished on its own. Handing this function an id that is already terminal is
 * exactly that situation, without needing to win a race to reproduce it.
 */
describe("failUnfinishedJobs", () => {
	let agentId: string;
	let deviceId: string;

	beforeEach(async () => {
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

	/** Creates a job in the given state and returns its id. */
	async function jobIn(status: string, overrides: Record<string, unknown> = {}): Promise<string> {
		const job = await prisma.job.create({
			data: { agentId, deviceId, status, ...overrides },
			select: { id: true },
		});
		return job.id;
	}

	const failure = { errorCode: "agent_unpaired", errorMessage: "The agent was unpaired before this job finished." };

	it("fails the jobs that are still unfinished and names them back", async () => {
		const queued = await jobIn("QUEUED");
		const printing = await jobIn("PRINTING");

		const settled = await failUnfinishedJobs([queued, printing], failure);

		expect(settled.sort()).toEqual([queued, printing].sort());
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

		const settled = await failUnfinishedJobs([completed, queued], failure);

		expect(settled).toEqual([queued]);
		const row = await prisma.job.findUniqueOrThrow({ where: { id: completed } });
		expect(row.status).toBe("COMPLETED");
		expect(row.errorCode).toBeNull();
	});

	it("names back nothing when every job was already settled", async () => {
		// Nothing to announce, and nothing to log as repaired either — the whole set was answered by
		// someone else while this call was on its way.
		const first = await jobIn("COMPLETED", { finishedAt: new Date() });
		const second = await jobIn("CANCELLED", { finishedAt: new Date() });

		expect(await failUnfinishedJobs([first, second], failure)).toEqual([]);
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

		const settled = await failUnfinishedJobs(ids, failure);

		expect(settled).toHaveLength(ids.length);
		expect(await prisma.job.count({ where: { status: "FAILED" } })).toBe(ids.length);
	});
});
