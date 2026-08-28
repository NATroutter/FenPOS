import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveRef, ArchiveRow } from "@/app/(panel)/archives/actions";

/**
 * The Archives tab's two actions.
 *
 * Both are reads of a file that used to be rows, and the whole point of the tab is that an archive
 * nobody can open is storage rather than a record.
 *
 * **This file carries the gate for both actions, not just their bodies.** They are registered
 * `custom`, because which permission governs a call is decided by the period the call names, and
 * `permission-matrix.test.ts` walks only `command` and `query`. So what the matrix does generically
 * for every other action is done specifically here: refused holding neither permission, allowed
 * holding either, and refused per source in both directions.
 */
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// `revalidatePath` needs a request Next only builds while rendering, so the delete's refresh is stubbed
// out the way every other action test stubs it.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.50",
	getUserAgent: async () => "vitest",
}));

const currentSessionUser = vi.fn();
// No session ever rotates in this file's actions, so the audit row's session id is whatever
// `panel-action.ts`'s `record()` was already carrying — see `currentSessionId`'s own doc.
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => currentSessionUser(),
	currentSessionId: async (fallback: string) => fallback,
}));

/**
 * `AUDIT_ARCHIVE_DIRECTORY` resolves to `data/archives`, which is where a developer's own archives
 * live — and this file writes real ones through `archivePeriod`. Redirected at the one module that
 * owns the rule, exactly as `test/lib/maintenance/pass.test.ts` does, so the actions under test still
 * read the constant they read in production and only the value differs.
 */
vi.mock("@/lib/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/env")>();
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join: joinPath } = await import("node:path");
	const root = mkdtempSync(joinPath(tmpdir(), "fenpos-archives-"));
	return { ...actual, AUDIT_ARCHIVE_DIRECTORY: joinPath(root, "archives") };
});

const { deleteAuditArchive, listArchivePeriods, readArchivePage } = await import("@/app/(panel)/archives/actions");
const { archivePeriod } = await import("@/lib/archive/rotate");
const { appendEvent, SYSTEM_ACTOR } = await import("@/lib/audit/audit-log");
const { readEpoch } = await import("@/lib/audit/epoch");
const { verifyAuditChain } = await import("@/lib/audit/verify");
const { auditDb, logsDb, prisma } = await import("@/lib/db");
const { AUDIT_ARCHIVE_DIRECTORY } = await import("@/lib/env");

let nextAccount = 0;

/**
 * An account with an id no earlier case has used — `effectivePermissions` memoises per id — signed
 * in for the rest of the case.
 *
 * @param permissions the individual grants to give it
 * @param isSuperuser whether it bypasses every check
 * @returns the signed-in user
 */
async function account(permissions: string[], isSuperuser = false) {
	nextAccount += 1;
	const id = `archive-action-${nextAccount}`;
	await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser } });
	for (const permission of permissions) {
		await prisma.userPermission.create({ data: { userId: id, permission } });
	}
	const user = { id, name: id, email: `${id}@example.com`, isSuperuser, mustChangePassword: false };
	currentSessionUser.mockResolvedValue(user);
	return user;
}

/**
 * The first instant of the month after a period, which is the exclusive boundary `archivePeriod`
 * takes to name that period.
 *
 * @param periodKey e.g. `2026-01`
 * @returns the first instant of `2026-02`, in UTC
 */
function afterPeriod(periodKey: string): Date {
	const [year, month] = periodKey.split("-").map(Number);
	// `Date.UTC`'s month is zero-based, so a one-based month is already the month after it.
	return new Date(Date.UTC(year, month, 1));
}

/**
 * Leaves one finished `logs-<periodKey>.db.gz` on disk, holding one line per message.
 *
 * Written through `archivePeriod` rather than by hand, so a change to what an archive looks like
 * fails here rather than passing against a fixture nothing in production writes.
 *
 * @param periodKey the period to archive
 * @param messages one line per entry
 */
async function logArchive(periodKey: string, messages: string[]): Promise<void> {
	await logsDb.logEntry.createMany({
		data: messages.map((message) => ({
			level: "INFO" as const,
			severity: 1,
			message,
			ts: new Date(`${periodKey}-15T00:00:00Z`),
		})),
	});
	await archivePeriod({ source: "logs", before: afterPeriod(periodKey), directory: AUDIT_ARCHIVE_DIRECTORY });
}

/**
 * Leaves one finished `audit-<periodKey>.db.gz` on disk, holding one event per action named.
 *
 * The clock is faked for the appends alone: `at` is one of the fields the chain hashes, so a
 * backdated row would fail the very chain check `archivePeriod` runs before it lets anything leave
 * the live database.
 *
 * The first row is read back before the rotation removes it, because that row is exactly what the
 * epoch names while this period is the oldest archive on disk — so a case can say what the epoch
 * should become without asking the code under test.
 *
 * @param periodKey the period to archive
 * @param actions one event per entry
 * @returns the `seq` and `prevHash` of the period's first event
 */
async function auditArchive(periodKey: string, actions: string[]): Promise<{ seq: number; prevHash: string }> {
	vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${periodKey}-15T00:00:00Z`) });
	try {
		for (const action of actions) {
			await appendEvent({ action, outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		}
	} finally {
		vi.useRealTimers();
	}

	// Every earlier period has already been archived and removed, so the oldest live row is this
	// period's first one.
	const first = await auditDb.auditEvent.findFirstOrThrow({
		orderBy: { seq: "asc" },
		select: { seq: true, prevHash: true },
	});
	await archivePeriod({ source: "audit", before: afterPeriod(periodKey), directory: AUDIT_ARCHIVE_DIRECTORY });
	return first;
}

/**
 * Whether an audit period is still on disk.
 *
 * @param periodKey the period to look for
 * @returns true while its archive file exists
 */
function auditArchiveExists(periodKey: string): boolean {
	return existsSync(join(AUDIT_ARCHIVE_DIRECTORY, `audit-${periodKey}.db.gz`));
}

/**
 * The one field that says which row this is, for whichever kind of row it is.
 *
 * The union is the point of the shape under test — a log line is read for its message and a recorded
 * event for its action — so the assertions reach for whichever of the two the archive holds rather
 * than flattening both into a field neither has.
 *
 * @param rows a page's rows
 * @returns the message of each log line, or the action of each recorded event
 */
function words(rows: ArchiveRow[]): string[] {
	return rows.map((row) => (row.kind === "audit" ? row.action : row.message));
}

/** The newest row in the record, which for these actions is the one they just wrote. */
async function newestAuditRow() {
	return auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
}

beforeEach(async () => {
	await auditDb.auditEvent.deleteMany({});
	await auditDb.auditAnchor.deleteMany({});
	await auditDb.auditEpoch.deleteMany({});
	await logsDb.logEntry.deleteMany({});
	await prisma.userPermission.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.account.deleteMany({});
	await prisma.user.deleteMany({});
	currentSessionUser.mockReset();
	rmSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true, force: true });
	mkdirSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true });
});

afterAll(() => {
	rmSync(dirname(AUDIT_ARCHIVE_DIRECTORY), { recursive: true, force: true });
});

describe("listArchivePeriods", () => {
	it("returns the periods on disk, newest first", async () => {
		await account([], true);
		await logArchive("2026-01", ["january"]);
		await auditArchive("2026-02", ["test:february"]);
		await logArchive("2026-03", ["march"]);

		const listing = await listArchivePeriods();

		expect(listing.error).toBeNull();
		// Goes red the moment the ordering is left to `listArchives`, which promises none: it returns
		// the directory in whatever order the filesystem gave it, which is not age order in either
		// direction and interleaves the two sources by filename at best.
		expect(listing.periods.map((period) => `${period.source}-${period.periodKey}`)).toEqual([
			"logs-2026-03",
			"audit-2026-02",
			"logs-2026-01",
		]);
	});

	it("does not offer an abandoned rotation attempt as a period", async () => {
		await account([], true);
		await logArchive("2026-01", ["january"]);
		// The name a rotation writes under until the live rows are actually gone. It holds rows the
		// live database still has, so listing it as a period would offer the operator a second copy of
		// what is already there — or, if the attempt died early, an empty one.
		const partial = join(AUDIT_ARCHIVE_DIRECTORY, "logs-2026-02.db.11111111-2222-3333-4444-555555555555.partial");
		writeFileSync(partial, "an abandoned rotation attempt");

		const listing = await listArchivePeriods();

		// The precondition, asserted rather than assumed: without a `.partial` genuinely on disk this
		// case would pass against a directory that simply never had one.
		expect(existsSync(partial)).toBe(true);
		// And the finished archive is still listed, so an empty answer cannot pass this either.
		expect(listing.periods.map((period) => `${period.source}-${period.periodKey}`)).toEqual(["logs-2026-01"]);
	});

	it("leaves out the audit periods a caller may not read", async () => {
		await auditArchive("2026-02", ["test:february"]);
		await logArchive("2026-01", ["january"]);
		await account(["logs:read"]);

		const listing = await listArchivePeriods();

		// Both are on disk; only one is this caller's to see. Goes red if the listing hands back
		// whatever is in the directory, which would tell somebody without `audit:read` exactly which
		// months of the record exist.
		expect(listing.periods.map((period) => period.source)).toEqual(["logs"]);
	});

	it("offers the audit periods to a caller holding audit:read and no logs:read", async () => {
		await auditArchive("2026-02", ["test:february"]);
		await logArchive("2026-01", ["january"]);
		await account(["audit:read"]);

		const listing = await listArchivePeriods();

		// The mirror of the case above, and the one the registry's `custom` kind exists for: a single
		// gated permission could only ever have been one of these two, and whichever was chosen would
		// have refused this caller outright rather than showing them their own half.
		expect(listing.error).toBeNull();
		expect(listing.periods.map((period) => period.source)).toEqual(["audit"]);
	});

	it("refuses a caller holding neither permission, and records the refusal", async () => {
		await logArchive("2026-01", ["january"]);
		await account([]);

		const listing = await listArchivePeriods();

		// Goes red if the per-source filter is the only check: an account holding nothing would then
		// get an empty list and a null error, which reads as "nothing has been archived" rather than
		// as "you may not look".
		expect(listing.periods).toEqual([]);
		expect(listing.error).toContain("permission");

		const row = await newestAuditRow();
		expect(row.action).toBe("archives:list");
		expect(row.outcome).toBe("DENIED");
		expect(row.detail).toContain("logs:read");
		expect(row.detail).toContain("audit:read");
	});

	it("says the list is not what is on disk when the directory cannot be read", async () => {
		await account([], true);
		// A file where the directory should be. `archiveDirectory()`'s `mkdirSync` refuses this exactly
		// as it would refuse a read-only volume, and it is the one such failure a test can arrange for
		// real — an absent directory heals itself, so this is the shape the failure actually takes.
		rmSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true, force: true });
		writeFileSync(AUDIT_ARCHIVE_DIRECTORY, "not a directory");

		const listing = await listArchivePeriods();

		// Goes red if a broken directory is reported as an empty one. The tab would then state, on the
		// one page whose job is saying where the record went, that nothing had been archived — which
		// nobody knows, because nothing could look.
		expect(listing.periods).toEqual([]);
		expect(listing.error).toContain("could not be read");

		const row = await newestAuditRow();
		expect(row.action).toBe("archives:list");
		expect(row.outcome).toBe("FAILURE");
	});
});

describe("readArchivePage", () => {
	it("returns the rows in the period it opens", async () => {
		await account(["logs:read"]);
		await logArchive("2026-01", ["archived line"]);

		const page = await readArchivePage({ source: "logs", periodKey: "2026-01" }, {});

		expect(page.error).toBeNull();
		expect(words(page.rows)).toEqual(["archived line"]);
	});

	it("refuses an audit period to a caller holding only logs:read, and records the refusal", async () => {
		await auditArchive("2026-02", ["test:one", "test:two"]);
		await account(["logs:read"]);

		const refused = await readArchivePage({ source: "audit", periodKey: "2026-02" }, {});

		expect(refused.rows).toEqual([]);
		expect(refused.error).toContain("permission");
		// Permission probing has to stay visible in the record, and as `DENIED` rather than `FAILURE`:
		// `/audit` tells the two apart by colour precisely so a page of refusals reads as somebody
		// probing rather than as an install that is broken.
		const row = await newestAuditRow();
		expect(row.action).toBe("archives:read");
		expect(row.outcome).toBe("DENIED");
		expect(row.detail).toContain("audit:read");

		// The same period, opened by somebody who may. Without this the case above would pass just as
		// happily against an archive that was empty or unreadable for reasons of its own — and it goes
		// red if the `audit:read` check is dropped, because then the refused call returns these rows.
		await account([], true);
		const allowed = await readArchivePage({ source: "audit", periodKey: "2026-02" }, {});
		expect(allowed.error).toBeNull();
		expect(words(allowed.rows)).toEqual(["test:two", "test:one"]);
	});

	it("opens an audit period for a caller holding audit:read and no logs:read", async () => {
		await auditArchive("2026-02", ["test:one", "test:two"]);
		await account(["audit:read"]);

		const page = await readArchivePage({ source: "audit", periodKey: "2026-02" }, {});

		// The account the widened gate exists for. Goes red if either gate narrows back to one named
		// permission: an auditor who holds no `logs:read` would be refused their own archives.
		expect(page.error).toBeNull();
		expect(words(page.rows)).toEqual(["test:two", "test:one"]);
	});

	it("refuses a log period to a caller holding only audit:read", async () => {
		await logArchive("2026-01", ["january"]);
		await account(["audit:read"]);

		const refused = await readArchivePage({ source: "logs", periodKey: "2026-01" }, {});

		// The check runs in both directions, which is what makes it a per-source rule rather than a
		// special case bolted onto one source. Goes red if `audit:read` is treated as a master key.
		expect(refused.rows).toEqual([]);
		expect(refused.error).toContain("permission");
		const row = await newestAuditRow();
		expect(row.outcome).toBe("DENIED");
		expect(row.detail).toContain("logs:read");
	});

	it("refuses a period that is not on disk rather than opening whatever the caller named", async () => {
		await account(["logs:read"]);
		await logArchive("2026-01", ["january"]);

		const page = await readArchivePage({ source: "logs", periodKey: "2025-12" }, {});

		expect(page.rows).toEqual([]);
		expect(page.error).toContain("No archive");
	});

	it("reports a descriptor it cannot read rather than throwing before it has a session", async () => {
		await account(["logs:read"]);
		await logArchive("2026-01", ["january"]);

		// What a hostile client can actually post. The type says `ArchiveRef`; the wire says nothing of
		// the kind. Goes red if any field is dereferenced before the session is resolved and the guard
		// has run — that call would leave a raw `TypeError` and no audit row, making the one call this
		// action never records the hostile one.
		const page = await readArchivePage(null as unknown as ArchiveRef, {});

		expect(page.rows).toEqual([]);
		expect(page.error).toContain("not an archive");

		const row = await newestAuditRow();
		expect(row.action).toBe("archives:read");
		expect(row.outcome).toBe("FAILURE");
	});

	it("narrows a period to the rows that match a search", async () => {
		await account(["logs:read"]);
		await logArchive("2026-01", ["alpha one", "beta", "alpha two"]);

		const page = await readArchivePage({ source: "logs", periodKey: "2026-01" }, { search: "alpha" });

		// Goes red if the filter arms are dropped from the statement, which would return the whole
		// period under a heading that says otherwise.
		expect(page.error).toBeNull();
		expect(words(page.rows).sort()).toEqual(["alpha one", "alpha two"]);
	});

	it("pages a period larger than one read, without dropping or repeating a row", async () => {
		await account(["logs:read"]);
		// One more than a page holds, so exactly one row is left for the second page. Expressed through
		// what the first page returned rather than through the page size, which is the server's and is
		// not exported — a `"use server"` module may export only functions.
		const total = 101;
		await logArchive(
			"2026-01",
			Array.from({ length: total }, (_, index) => `line ${String(index).padStart(3, "0")}`),
		);
		const ref = { source: "logs", periodKey: "2026-01" } as const;

		const first = await readArchivePage(ref, {});
		const second = await readArchivePage(ref, { skip: first.rows.length });

		// Goes red if the read stops asking for one row more than it returns: `more` would be false on
		// a period with another page in it, and the operator would be told they had reached the end.
		expect(first.more).toBe(true);
		expect(second.more).toBe(false);
		expect(first.rows.length).toBeLessThan(total);
		// No row lost between the pages and none served twice — the two ways an off-by-one in the
		// slice shows up.
		const seen = new Set([...first.rows, ...second.rows].map((row) => row.id));
		expect(seen.size).toBe(total);
	});

	it("still returns the first page when the skip it is handed is not a usable offset", async () => {
		await account(["logs:read"]);
		await logArchive("2026-01", ["january"]);

		const page = await readArchivePage({ source: "logs", periodKey: "2026-01" }, { skip: -1.5 });

		// `skip` crosses the wire, so it is whatever was posted. Clamped to a whole number at or above
		// zero rather than handed to SQLite, which refuses a fractional bound outright.
		expect(page.error).toBeNull();
		expect(words(page.rows)).toEqual(["january"]);
	});
});

/**
 * The one action on this tab that removes anything.
 *
 * Log archives age out on a timer; audit archives never do, because they are evidence. This is the
 * deliberate way one goes, and every case below is about the two things that makes it: the epoch moves
 * with the file, so verification stays honest about a shortened record rather than accusing the
 * operator of losing it; and only a prefix may go, so what is left is still a chain an anchor can
 * vouch for.
 */
describe("deleteAuditArchive", () => {
	it("advances the epoch to the new oldest archive", async () => {
		await account([], true);
		await auditArchive("2026-01", ["test:january"]);
		// Two events, so the period's first row and its last are different rows: an epoch taken from the
		// wrong end of the archive that survives is a different failure from one that never moved, and a
		// one-event period could not tell them apart.
		const february = await auditArchive("2026-02", ["test:february", "test:february-again"]);
		await auditArchive("2026-03", ["test:march"]);

		const result = await deleteAuditArchive("2026-01");

		expect(result.error).toBeNull();
		expect(auditArchiveExists("2026-01")).toBe(false);

		// The real assertion, and it is a verification rather than a read of the row just written: goes
		// red if the file is deleted without moving the epoch, because the next walk then reports
		// `archive-missing` — accusing the operator of losing evidence they deliberately removed, which
		// is the false accusation the epoch exists to prevent, arriving from the other end.
		const verified = await verifyAuditChain(auditDb, {
			archiveDirectory: AUDIT_ARCHIVE_DIRECTORY,
			epoch: await readEpoch(),
		});
		expect(verified).toMatchObject({ ok: "incomplete", verifiedFrom: february.seq });

		// And the epoch names the row the surviving archives actually start on, `prevHash` included —
		// a `seq` that is right while the hash is not walks the oldest archive from the wrong link.
		expect(await readEpoch()).toEqual(february);
	});

	it("refuses without audit:archive-delete", async () => {
		await auditArchive("2026-01", ["test:january"]);
		const january = await readEpoch();
		await auditArchive("2026-02", ["test:february"]);
		// Every other audit permission, and not this one: `audit:export` in particular, because reusing
		// it would mean anyone who can produce a report can destroy evidence.
		await account(["audit:read", "audit:verify", "audit:export"]);

		const result = await deleteAuditArchive("2026-01");

		expect(result.error).toContain("permission");
		// The refusal has to have stopped the work, not merely worded the answer: the file is still
		// there and the epoch still names it.
		expect(auditArchiveExists("2026-01")).toBe(true);
		expect(await readEpoch()).toEqual(january);

		// Permission probing stays visible in the record, and as `DENIED` naming what was missing.
		const row = await newestAuditRow();
		expect(row.action).toBe("audit:archive-delete");
		expect(row.outcome).toBe("DENIED");
		expect(row.detail).toContain("audit:archive-delete");
	});

	it("writes an audit row naming the period removed", async () => {
		const user = await account(["audit:archive-delete"]);
		await auditArchive("2026-01", ["test:january"]);
		await auditArchive("2026-02", ["test:february"]);

		const result = await deleteAuditArchive("2026-01");

		expect(result.error).toBeNull();
		// Shrinking the audit record is itself recorded in the audit record, attributed to whoever did
		// it and naming which period went. Goes red if the row omits the target: a row saying only that
		// somebody deleted an archive leaves an investigator with no way to tell which one.
		const row = await newestAuditRow();
		expect(row.action).toBe("audit:archive-delete");
		expect(row.outcome).toBe("SUCCESS");
		expect(row.targetId).toBe("audit-2026-01");
		expect(row.actorEmail).toBe(user.email);
	});

	it("refuses to delete the newest audit archive", async () => {
		await account([], true);
		await auditArchive("2026-01", ["test:january"]);
		await auditArchive("2026-02", ["test:february"]);

		const result = await deleteAuditArchive("2026-02");

		// Deleting from the newest end would leave a hole the anchor cannot vouch for: the live rows
		// link back to the newest archived row, and nothing else can stand in for it. Only a prefix may
		// go, which is the same rule retention follows.
		expect(result.error).toContain("newest");
		expect(auditArchiveExists("2026-02")).toBe(true);
	});

	it("refuses to delete the only audit archive there is, because it is also the newest", async () => {
		await account([], true);
		const only = await auditArchive("2026-01", ["test:january"]);

		const result = await deleteAuditArchive("2026-01");

		// The case there is no honest epoch for. With no archive left, any epoch at all reports
		// `archive-missing` and no epoch at all reports the surviving live rows as the whole record —
		// an intact fraction presented as the thing itself. The newest rule is what makes it
		// unreachable: the last archive standing is always the newest one.
		expect(result.error).toContain("newest");
		expect(auditArchiveExists("2026-01")).toBe(true);
		expect(await readEpoch()).toEqual(only);
	});

	it("refuses to delete an audit archive that is not the oldest", async () => {
		await account([], true);
		const january = await auditArchive("2026-01", ["test:january"]);
		await auditArchive("2026-02", ["test:february"]);
		await auditArchive("2026-03", ["test:march"]);

		const result = await deleteAuditArchive("2026-02");

		// Not the newest either, and still refused: taking one out of the middle leaves the archive
		// after it linking to a row in a file that is gone, which the next walk reports as
		// `link-mismatch` — tampering, said of a record nobody tampered with. The epoch cannot describe
		// a hole; it only says where the record begins.
		expect(result.error).toContain("oldest");
		expect(auditArchiveExists("2026-02")).toBe(true);
		expect(await readEpoch()).toEqual(january);
	});

	it("does not remove a log archive of the same period", async () => {
		await account([], true);
		await logArchive("2026-01", ["january"]);
		const february = await auditArchive("2026-02", ["test:february"]);

		const result = await deleteAuditArchive("2026-01");

		// The one audit archive on disk is 2026-02, so 2026-01 names nothing this action may touch.
		// Goes red if the listing is not filtered by source: `logs-2026-01` would then be the oldest
		// archive found, and this call would delete a log period under an audit permission — and move
		// the epoch to a row no log archive has.
		expect(result.error).toContain("No archive");
		expect(existsSync(join(AUDIT_ARCHIVE_DIRECTORY, "logs-2026-01.db.gz"))).toBe(true);
		expect(await readEpoch()).toEqual(february);
	});

	it("reports a period key it cannot read rather than deleting anything", async () => {
		await account([], true);
		await auditArchive("2026-01", ["test:january"]);
		await auditArchive("2026-02", ["test:february"]);

		// What a hostile client can actually post. The type says a period key; the wire says nothing of
		// the kind.
		const result = await deleteAuditArchive("../../2026-01");

		expect(result.error).toContain("not an archive period");
		expect(auditArchiveExists("2026-01")).toBe(true);
		// The failure is recorded, and the row carries no target: an unchecked key would be echoed into
		// the record as one, which is a caller writing arbitrary text into the audit trail.
		const row = await newestAuditRow();
		expect(row.action).toBe("audit:archive-delete");
		expect(row.outcome).toBe("FAILURE");
		expect(row.targetId).toBeNull();
	});
});
