import { beforeEach, describe, expect, it, vi } from "vitest";
import { logsDb, prisma } from "@/lib/db";
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
		await logsDb.logEntry.deleteMany();
		await prisma.setting.deleteMany();
	});

	/** Seeds `count` lines, newest last, so paging has something to actually page through. */
	async function seedLines(count: number): Promise<void> {
		await logsDb.logEntry.createMany({
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

/**
 * Tests for ordering the Logs tab's Source column.
 *
 * `LOG_ORDER.source` orders by `agentName`/`deviceName`, not by `agentId`/`deviceId` — the two
 * disagree whenever two agents were not created in alphabetical order, which is the case this
 * suite has to cover: an id-based sort passed a fully green suite for a release before anyone
 * wrote a test that could tell the two apart.
 */
describe("listLogs sort", () => {
	beforeEach(async () => {
		await logsDb.logEntry.deleteMany();
		await prisma.setting.deleteMany();
	});

	it("orders the source column alphabetically by name, not by agent creation order", async () => {
		// Created in reverse alphabetical order: cuids are roughly creation-ordered, so "zebra-source"
		// (created first) gets the lower id even though "apple-source" sorts first by name. Sorting by
		// id would therefore return these two lines in the opposite order to sorting by name.
		const zebra = await prisma.agent.create({ data: { name: "zebra-source" } });
		const apple = await prisma.agent.create({ data: { name: "apple-source" } });

		await recordServerLog("INFO", "from zebra", { agentId: zebra.id, agentName: zebra.name });
		await recordServerLog("INFO", "from apple", { agentId: apple.id, agentName: apple.name });

		const page = await listLogs({ sort: "source", desc: false });

		expect(page.lines.map((line) => line.message)).toEqual(["from apple", "from zebra"]);
	});
});

describe("recordServerLog", () => {
	// Without this, rows left behind by "listLogs paging" above (and by earlier tests in this
	// block) bleed into the length and findFirst() assertions below — confirmed by running this
	// suite without it, which fails all three non-throwing tests on stale rows.
	beforeEach(async () => {
		await logsDb.logEntry.deleteMany();
		await prisma.setting.deleteMany();
	});

	it("writes a row the Logs tab will show", async () => {
		await recordServerLog("INFO", "Something an operator should see");

		const rows = await logsDb.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].message).toBe("Something an operator should see");
		expect(rows[0].agentId).toBeNull();
	});

	it("derives severity so the level filter and column ordering work", async () => {
		await recordServerLog("WARN", "careful");

		expect((await logsDb.logEntry.findFirst())?.severity).toBe(2);
	});

	it("attributes a line to a device when one is named", async () => {
		const agent = await prisma.agent.create({ data: { name: `agent-${Date.now()}` } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "kitchen", port: "COM1", columns: 42 },
		});

		await recordServerLog("INFO", "about a printer", { agentId: agent.id, deviceId: device.id });

		const row = await logsDb.logEntry.findFirst();
		expect(row?.agentId).toBe(agent.id);
		expect(row?.deviceId).toBe(device.id);
	});

	it("truncates to logs.maxMessageChars, the same bound an agent's lines get", async () => {
		// One table, one limit. An install that lowers this meant it for every row it stores, and a
		// server-side audit line that ignored it would leave the Logs tab holding two kinds of line
		// with two different ceilings. 200 is the setting's declared minimum.
		await setSetting("logs.maxMessageChars", 200);

		await recordServerLog("INFO", "x".repeat(500));

		expect((await logsDb.logEntry.findFirst())?.message).toHaveLength(200);
	});

	it("keeps an agent's name on its lines after the agent is deleted", async () => {
		const agent = await prisma.agent.create({ data: { name: "kitchen" } });
		await recordServerLog("WARN", "raw write refused", { agentId: agent.id, agentName: agent.name });

		await prisma.agent.delete({ where: { id: agent.id } });

		const page = await listLogs({});
		const line = page.lines.find((entry) => entry.message === "raw write refused");
		// Goes red if the name is not written onto the row at insert: once the agent is gone, there is
		// no relation left to read it from, so a line with only `agentId` has no way to report where
		// it came from.
		expect(line?.agentName).toBe("kitchen");
	});

	it("does not throw when the row cannot be written", async () => {
		// Audit logging must never be the reason a request fails. A line lost is bad; a raw write
		// refused because its audit line could not be stored is worse, and a raw write that *happened*
		// and then threw on the way out is worst of all.
		//
		// The failure is injected rather than provoked with an agent id matching nothing, which is how
		// this test used to reach the catch. Log lines live in their own database now, and it holds no
		// foreign key to `agents` — an unknown id stores perfectly well, so asserting on one would be
		// asserting that a write *succeeds*. Injecting a rejection keeps the assertion about the
		// failure path this test is named for.
		const create = vi.spyOn(logsDb.logEntry, "create").mockRejectedValueOnce(new Error("no space left on device"));

		try {
			await expect(recordServerLog("INFO", "orphan")).resolves.toBeUndefined();
			expect(create).toHaveBeenCalledTimes(1);
		} finally {
			create.mockRestore();
		}
	});
});
