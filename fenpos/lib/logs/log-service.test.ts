import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { listLogs } from "@/lib/logs/log-service";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Tests for the Logs tab's paging.
 *
 * The behaviour worth pinning down is that `panel.logPageSize` actually reaches `listLogs`, not
 * merely that `setSetting` stores it — `settings-service.test.ts` already covers storage.
 */
describe("listLogs paging", () => {
	beforeEach(async () => {
		await prisma.logEntry.deleteMany();
		await prisma.setting.deleteMany();
	});

	/** Seeds `count` lines, newest last, so paging has something to actually page through. */
	async function seedLines(count: number): Promise<void> {
		await prisma.logEntry.createMany({
			data: Array.from({ length: count }, (_, index) => ({
				level: "INFO",
				severity: 1,
				message: `line ${index}`,
				ts: new Date(Date.now() + index),
			})),
		});
	}

	it("pages at the built-in default when nothing is configured", async () => {
		await seedLines(110);

		const page = await listLogs();

		expect(page.lines).toHaveLength(100);
		expect(page.more).toBe(true);
	});

	it("pages logs at the configured size, not the built-in default", async () => {
		// 10 is panel.logPageSize's declared minimum. (The brief that generated this task said 3;
		// setSetting rejects that, since the declared minimum is 10 — corrected here.)
		await setSetting("panel.logPageSize", 10);
		await seedLines(15);

		const page = await listLogs();

		expect(page.lines).toHaveLength(10);
		expect(page.more).toBe(true);
	});

	it("still honours an explicit take even when a page size is configured", async () => {
		await setSetting("panel.logPageSize", 10);
		await seedLines(10);

		const page = await listLogs({ take: 3 });

		expect(page.lines).toHaveLength(3);
	});
});
