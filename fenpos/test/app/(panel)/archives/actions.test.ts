import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Archives tab's two actions.
 *
 * Both are reads of a file that used to be rows, and the whole point of the tab is that an archive
 * nobody can open is storage rather than a record. What is worth pinning here is not that
 * `listArchives` works — `test/lib/archive/read.test.ts` covers that — but the four things this
 * layer adds on top of it: the periods come back newest-first, a period opens and yields rows, an
 * audit period does not open for somebody holding only `logs:read`, and a rotation's abandoned
 * `*.partial` file is not offered as a period at all.
 *
 * The gate on `logs:read` itself is proved by `permission-matrix.test.ts`, which walks every entry.
 * The per-source check on top of it is this file's job, because the registry names one permission
 * per action and cannot express "audit archives also need `audit:read`".
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
 * Leaves one finished `logs-<periodKey>.db.gz` on disk, holding one line.
 *
 * Written through `archivePeriod` rather than by hand, so a change to what an archive looks like
 * fails here rather than passing against a fixture nothing in production writes.
 *
 * @param periodKey the period to archive
 * @param message the line's text
 */
async function logArchive(periodKey: string, message: string): Promise<void> {
	await logsDb.logEntry.create({
		data: { level: "INFO", severity: 1, message, ts: new Date(`${periodKey}-15T00:00:00Z`) },
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
		await logArchive("2026-01", "january");
		await auditArchive("2026-02", ["test:february"]);
		await logArchive("2026-03", "march");

		const periods = await listArchivePeriods();

		// Goes red the moment the ordering is left to `listArchives`, which returns whatever
		// `readdirSync` hands back: that is alphabetical, so it puts `audit-2026-02` first and the
		// oldest log period ahead of the newest.
		expect(periods.map((period) => `${period.source}-${period.periodKey}`)).toEqual([
			"logs-2026-03",
			"audit-2026-02",
			"logs-2026-01",
		]);
	});

	it("does not offer an abandoned rotation attempt as a period", async () => {
		await account([], true);
		await logArchive("2026-01", "january");
		// The name a rotation writes under until the live rows are actually gone. It holds rows the
		// live database still has, so listing it as a period would offer the operator a second copy of
		// what is already there — or, if the attempt died early, an empty one.
		const partial = join(AUDIT_ARCHIVE_DIRECTORY, "logs-2026-02.db.11111111-2222-3333-4444-555555555555.partial");
		writeFileSync(partial, "an abandoned rotation attempt");

		const periods = await listArchivePeriods();

		// The precondition, asserted rather than assumed: without a `.partial` genuinely on disk this
		// case would pass against a directory that simply never had one.
		expect(existsSync(partial)).toBe(true);
		// And the finished archive is still listed, so an empty answer cannot pass this either.
		expect(periods.map((period) => `${period.source}-${period.periodKey}`)).toEqual(["logs-2026-01"]);
	});

	it("leaves out the audit periods a caller may not read", async () => {
		await auditArchive("2026-02", ["test:february"]);
		await logArchive("2026-01", "january");
		await account(["logs:read"]);

		const periods = await listArchivePeriods();

		// Both are on disk; only one is this caller's to see. Goes red if the listing hands back
		// whatever is in the directory, which would tell somebody without `audit:read` exactly which
		// months of the record exist.
		expect(periods.map((period) => period.source)).toEqual(["logs"]);
	});
});

describe("readArchivePage", () => {
	it("returns the rows in the period it opens", async () => {
		await account(["logs:read"]);
		await logArchive("2026-01", "archived line");

		const page = await readArchivePage({ source: "logs", periodKey: "2026-01" }, {});

		expect(page.error).toBeNull();
		expect(page.rows.map((row) => (row.kind === "logs" ? row.message : row.action))).toEqual(["archived line"]);
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
		const row = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("archives:read");
		expect(row.outcome).toBe("DENIED");
		expect(row.detail).toContain("audit:read");

		// The same period, opened by somebody who may. Without this the case above would pass just as
		// happily against an archive that was empty or unreadable for reasons of its own — and it goes
		// red if the `audit:read` check is dropped, because then the refused call returns these rows.
		await account([], true);
		const allowed = await readArchivePage({ source: "audit", periodKey: "2026-02" }, {});
		expect(allowed.error).toBeNull();
		expect(allowed.rows.map((row) => (row.kind === "audit" ? row.action : row.message))).toEqual([
			"test:two",
			"test:one",
		]);
	});

	it("refuses a period that is not on disk rather than opening whatever the caller named", async () => {
		await account(["logs:read"]);
		await logArchive("2026-01", "january");

		const page = await readArchivePage({ source: "logs", periodKey: "2025-12" }, {});

		expect(page.rows).toEqual([]);
		expect(page.error).toContain("No archive");
	});
});
