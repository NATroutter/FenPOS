import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { listJobs } from "@/lib/jobs/job-service";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Tests for the Jobs tab's paging.
 *
 * The behaviour worth pinning down is that `panel.jobPageSize` actually reaches `listJobs`, not
 * merely that `setSetting` stores it — `settings-service.test.ts` already covers storage.
 */
describe("listJobs paging", () => {
	let agentId: string;
	let deviceId: string;

	beforeEach(async () => {
		await prisma.job.deleteMany();
		await prisma.device.deleteMany();
		await prisma.agent.deleteMany();
		await prisma.setting.deleteMany();

		agentId = (await prisma.agent.create({ data: { name: "site-a" }, select: { id: true } })).id;
		deviceId = (await prisma.device.create({ data: { agentId, name: "kitchen", port: "COM3" }, select: { id: true } }))
			.id;
	});

	/** Seeds `count` jobs, newest last, so paging has something to actually page through. */
	async function seedJobs(count: number): Promise<void> {
		await prisma.job.createMany({
			data: Array.from({ length: count }, (_, index) => ({
				agentId,
				deviceId,
				status: "COMPLETED",
				submittedAt: new Date(Date.now() + index),
			})),
		});
	}

	it("pages at the built-in default when nothing is configured", async () => {
		await seedJobs(55);

		const page = await listJobs({});

		expect(page.jobs).toHaveLength(50);
		expect(page.more).toBe(true);
	});

	it("pages jobs at the configured size, not the built-in default", async () => {
		// 10 is panel.jobPageSize's declared minimum. (The brief that generated this task said 3;
		// setSetting rejects that, since the declared minimum is 10 — corrected here.)
		await setSetting("panel.jobPageSize", 10);
		await seedJobs(15);

		const page = await listJobs({});

		expect(page.jobs).toHaveLength(10);
		expect(page.more).toBe(true);
	});

	it("still honours an explicit take even when a page size is configured", async () => {
		await setSetting("panel.jobPageSize", 10);
		await seedJobs(10);

		const page = await listJobs({ take: 3 });

		expect(page.jobs).toHaveLength(3);
	});
});
