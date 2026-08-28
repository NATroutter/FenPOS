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

const { listArchivePeriods, readArchivePage } = await import("@/app/(panel)/archives/actions");
const { archivePeriod } = await import("@/lib/archive/rotate");
const { appendEvent, SYSTEM_ACTOR } = await import("@/lib/audit/audit-log");
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
 * @param periodKey the period to archive
 * @param actions one event per entry
 */
async function auditArchive(periodKey: string, actions: string[]): Promise<void> {
	vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${periodKey}-15T00:00:00Z`) });
	try {
		for (const action of actions) {
			await appendEvent({ action, outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		}
	} finally {
		vi.useRealTimers();
	}
	await archivePeriod({ source: "audit", before: afterPeriod(periodKey), directory: AUDIT_ARCHIVE_DIRECTORY });
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
