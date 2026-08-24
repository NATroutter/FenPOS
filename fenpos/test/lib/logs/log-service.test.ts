import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { listLogs, recordServerLog } from "@/lib/logs/log-service";
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

describe("recordServerLog", () => {
	// Without this, rows left behind by "listLogs paging" above (and by earlier tests in this
	// block) bleed into the length and findFirst() assertions below — confirmed by running this
	// suite without it, which fails all three non-throwing tests on stale rows.
	beforeEach(async () => {
		await prisma.logEntry.deleteMany();
	});

	it("writes a row the Logs tab will show", async () => {
		await recordServerLog("INFO", "Something an operator should see");

		const rows = await prisma.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].message).toBe("Something an operator should see");
		expect(rows[0].agentId).toBeNull();
	});

	it("derives severity so the level filter and column ordering work", async () => {
		await recordServerLog("WARN", "careful");

		expect((await prisma.logEntry.findFirst())?.severity).toBe(2);
	});

	it("attributes a line to a device when one is named", async () => {
		const agent = await prisma.agent.create({ data: { name: `agent-${Date.now()}` } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "kitchen", port: "COM1", columns: 42 },
		});

		await recordServerLog("INFO", "about a printer", { agentId: agent.id, deviceId: device.id });

		const row = await prisma.logEntry.findFirst();
		expect(row?.agentId).toBe(agent.id);
		expect(row?.deviceId).toBe(device.id);
	});

	it("does not throw when the row cannot be written", async () => {
		// Audit logging must never be the reason a request fails. A line lost is bad; a raw write
		// refused because its audit line could not be stored is worse, and a raw write that *happened*
		// and then threw on the way out is worst of all.
		await expect(recordServerLog("INFO", "orphan", { agentId: "no-such-agent" })).resolves.toBeUndefined();
	});
});
