import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { logsDb, prisma } from "@/lib/db";
import { AUDIT_ARCHIVE_DIRECTORY } from "@/lib/env";
import { logger } from "@/lib/logger";
import { archiveCovering, listLogs, recordServerLog } from "@/lib/logs/log-service";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * `AUDIT_ARCHIVE_DIRECTORY` resolves to `data/archives`, which is where a developer's own archives
 * live — and `archiveCovering` reads whatever is in it. Redirected at the one module that owns the
 * rule, the way `test/lib/maintenance/pass.test.ts` redirects it, so the code under test still reads
 * the constant it reads in production and only the value differs.
 */
vi.mock("@/lib/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/env")>();
	const { mkdtempSync: makeTemp } = await import("node:fs");
	const { tmpdir: temp } = await import("node:os");
	const { join: joinPath } = await import("node:path");
	return { ...actual, AUDIT_ARCHIVE_DIRECTORY: joinPath(makeTemp(joinPath(temp(), "fenpos-logs-")), "archives") };
});

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

	it("stores and lists the API key that produced the line", async () => {
		const key = await prisma.apiKey.create({
			data: { name: "Till 4", keyHash: "hash-1", maskedHint: "ab12" },
		});

		await recordServerLog("INFO", "a raw write from Till 4", { apiKeyId: key.id });

		const row = await logsDb.logEntry.findFirst();
		expect(row?.apiKeyId).toBe(key.id);

		const page = await listLogs({});
		const line = page.lines.find((entry) => entry.message === "a raw write from Till 4");
		expect(line?.apiKeyId).toBe(key.id);
	});

	it("still lists a line with its message intact once its API key no longer resolves", async () => {
		// There is no relation to an API key — logs.db cannot reach the application's tables, the same
		// reason `agentId` has none — so a deleted key leaves an id nothing resolves, rather than one
		// nulled out by a foreign key action. What keeps the line meaningful is that the key's *name*
		// is written into the message itself, not into a denormalised column: this test's whole point
		// goes red if the message ever stopped carrying that name.
		await recordServerLog("WARN", "raw write refused for key Till 4", { apiKeyId: "key-now-gone" });

		const page = await listLogs({});
		const line = page.lines.find((entry) => entry.message === "raw write refused for key Till 4");

		expect(line?.apiKeyId).toBe("key-now-gone");
		expect(line?.message).toBe("raw write refused for key Till 4");
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

/**
 * Tests for the two filters the Logs tab's own controls put into the URL.
 *
 * The date range is not decoration: the signpost tells an operator their range reaches back before
 * the live window, and a list that ignored the range while the signpost talked about it would be
 * two views of two different questions on one page.
 */
describe("listLogs narrowed by key and by range", () => {
	beforeEach(async () => {
		await logsDb.logEntry.deleteMany();
		await prisma.setting.deleteMany();
	});

	it("filters live lines by API key", async () => {
		const till = await prisma.apiKey.create({ data: { name: "Till 4", keyHash: "hash-till-4", maskedHint: "ab12" } });
		const kiosk = await prisma.apiKey.create({ data: { name: "Kiosk", keyHash: "hash-kiosk", maskedHint: "cd34" } });

		await recordServerLog("INFO", "a raw write from Till 4", { apiKeyId: till.id });
		await recordServerLog("INFO", "a raw write from Kiosk", { apiKeyId: kiosk.id });
		await recordServerLog("INFO", "something the panel itself did");

		const page = await listLogs({ apiKeyId: till.id });

		// Goes red if the filter is dropped on the floor: without it all three lines come back, since
		// the other two are exactly the lines an operator asking "what has this key been doing" does
		// not want to read.
		expect(page.lines.map((line) => line.message)).toEqual(["a raw write from Till 4"]);
	});

	it("filters live lines to the range asked for", async () => {
		await logsDb.logEntry.createMany({
			data: [
				{ level: "INFO", severity: 1, message: "before", ts: new Date("2026-05-01T12:00:00.000Z") },
				{ level: "INFO", severity: 1, message: "inside", ts: new Date("2026-05-10T12:00:00.000Z") },
				{ level: "INFO", severity: 1, message: "after", ts: new Date("2026-05-20T12:00:00.000Z") },
			],
		});

		const page = await listLogs({
			from: new Date("2026-05-05T00:00:00.000Z"),
			to: new Date("2026-05-15T00:00:00.000Z"),
		});

		// Goes red if either bound is dropped: losing `from` brings "before" back, losing `to` brings
		// "after" back, and losing both brings all three.
		expect(page.lines.map((line) => line.message)).toEqual(["inside"]);
	});
});

/**
 * Tests for the signpost.
 *
 * This is the affordance that makes the live/archived split honest. Without it, separating the two
 * relocates the operator's failure from "the data is gone" to "the data is somewhere you were not
 * told to look", which is an improvement only in principle.
 *
 * Every fixture here is an empty file with an archive's name. That is a faithful fixture rather than
 * a shortcut: `archiveCovering` never opens an archive — it reads the directory listing and decides
 * from the parsed `source` and `periodKey` — so a real compressed period would prove nothing this
 * does not, at the cost of a `mkdtemp` and a rotation per test.
 */
describe("archiveCovering", () => {
	beforeEach(() => {
		rmSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true, force: true });
		mkdirSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true });
	});

	afterAll(() => {
		rmSync(dirname(AUDIT_ARCHIVE_DIRECTORY), { recursive: true, force: true });
	});

	/** Puts one archive on disk, under exactly the name `archivePeriod` would have left. */
	function archived(name: string): void {
		writeFileSync(join(AUDIT_ARCHIVE_DIRECTORY, name), "");
	}

	it("offers the archive covering a range that starts before the live window", async () => {
		archived("logs-2026-03.db.gz");

		const covering = await archiveCovering({
			from: new Date("2026-03-05T00:00:00.000Z"),
			to: new Date("2026-03-20T00:00:00.000Z"),
		});

		// Goes red when a range that reaches into an archived period is answered with nothing — which
		// is the half of the signpost that lives here. The other half is the tab's: `page.tsx` asks
		// only when a range was filtered on, and renders nothing when the answer is null. Neither of
		// those two conditions is observable from this file, so this assertion is about
		// `archiveCovering` naming the period, not about what the page does with the name.
		expect(covering).toBe("2026-03");
	});

	it("takes a range with no end as reaching up to now", async () => {
		// The period is in the past relative to any clock this suite can run on, and the range has no
		// upper bound — which is how "everything since March" arrives from the tab, and the most common
		// way an operator asks this question at all.
		archived("logs-2026-03.db.gz");

		const covering = await archiveCovering({ from: new Date("2026-03-05T00:00:00.000Z") });

		// Goes red if the open end is resolved to anything earlier than the present: the archive falls
		// outside the range, and every unbounded filter silently loses its signpost. Every other test
		// here either passes an explicit `to` or expects null, so this is the only one that can see it.
		expect(covering).toBe("2026-03");
	});

	it("offers nothing when no archive covers the range", async () => {
		// Both files are near misses, and they are what gives this test teeth: an implementation that
		// always answered null would pass it, but so would one that never looked at the range's end
		// (offering September) or one that matched on the filename instead of the parsed `source`
		// (offering the audit record's March to somebody reading the log).
		archived("logs-2026-09.db.gz");
		archived("audit-2026-03.db.gz");

		const covering = await archiveCovering({
			from: new Date("2026-03-01T00:00:00.000Z"),
			to: new Date("2026-03-31T23:59:59.999Z"),
		});

		expect(covering).toBeNull();
	});

	it("offers the oldest period the range reaches into, not the newest", async () => {
		archived("logs-2026-02.db.gz");
		archived("logs-2026-04.db.gz");

		const covering = await archiveCovering({
			from: new Date("2026-01-10T00:00:00.000Z"),
			to: new Date("2026-05-01T00:00:00.000Z"),
		});

		// Goes red on a newest-first pick, which is the plausible mistake here: the Archives tab
		// deliberately sorts newest first, because the period somebody came looking for is usually the
		// one that just aged out. This question is the other way round — the range starts in January,
		// so where its history begins is February, and April is somewhere in the middle of it.
		expect(covering).toBe("2026-02");
	});

	it("offers the oldest period a range that is open at the start reaches into", async () => {
		archived("logs-2026-02.db.gz");
		archived("logs-2026-03.db.gz");
		archived("logs-2026-05.db.gz");

		const covering = await archiveCovering({ to: new Date("2026-03-31T23:59:59.999Z") });

		// "Everything up to the end of March" is a range and it does reach back, so it gets a signpost.
		// Goes red two ways: if a missing start is read as the present rather than as an open end, in
		// which case nothing matches and an operator who filled in one of the tab's two date fields is
		// told there is nothing to find; and if the newest match is offered rather than the oldest,
		// which gives "2026-03". May is out of scope either way, which is the sibling test's job.
		expect(covering).toBe("2026-02");
	});

	it("places the range's months in UTC, not the host's zone", async () => {
		archived("logs-2026-03.db.gz");
		archived("logs-2026-04.db.gz");

		// 22:30Z on the last day of March is already April on any host east of Greenwich, and 01:00Z on
		// the first of April is still March on any host west of it. So the first assertion goes red for
		// a local-time reading on a positive offset and the second for one on a negative offset — one
		// of the two is live wherever this runs, except on a host at exactly UTC, where local and UTC
		// field accessors are numerically identical and no assertion can tell the two apart.
		const endOfMarch = new Date("2026-03-31T22:30:00.000Z");
		const startOfApril = new Date("2026-04-01T01:00:00.000Z");

		expect(await archiveCovering({ from: endOfMarch, to: startOfApril })).toBe("2026-03");
		expect(await archiveCovering({ from: new Date("2026-04-01T00:00:00.000Z"), to: startOfApril })).toBe("2026-04");
	});

	it("says nothing rather than failing the whole page when the archive directory cannot be read", async () => {
		// A file where the directory should be: `archiveDirectory()`'s mkdirSync refuses it, which is
		// the narrow, real case of a path an operator has provisioned wrongly. The Logs tab's job is
		// showing live lines, so a signpost that could not be looked up must not be the reason the tab
		// itself stops rendering — but it must still reach the server log rather than vanish.
		rmSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true, force: true });
		writeFileSync(AUDIT_ARCHIVE_DIRECTORY, "");
		const failed = vi.spyOn(logger, "error").mockImplementation(() => {});

		try {
			await expect(archiveCovering({ from: new Date("2026-03-05T00:00:00.000Z") })).resolves.toBeNull();
			expect(failed).toHaveBeenCalledTimes(1);
		} finally {
			failed.mockRestore();
		}
	});
});
