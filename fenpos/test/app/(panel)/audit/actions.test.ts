import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Audit tab's two actions.
 *
 * Both are reads, and both are recorded as commands: an export is somebody taking a copy of the
 * record away, which is the single most worth-recording read the system has.
 *
 * The gate itself is proved for these two by `permission-matrix.test.ts`, which walks every entry.
 * What is left here is what the matrix cannot see — that the bodies do the right thing once allowed.
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
 * live — and `verifyChain` now walks whatever is in it. Redirected at the one module that owns the
 * rule, exactly as `test/app/(panel)/archives/actions.test.ts` does, so the action under test still
 * reaches the directory through `archiveDirectory()` and only the value differs.
 */
vi.mock("@/lib/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/env")>();
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "fenpos-audit-actions-"));
	return { ...actual, AUDIT_ARCHIVE_DIRECTORY: join(root, "archives") };
});

const { exportAuditCsv, verifyChain } = await import("@/app/(panel)/audit/actions");
const { archivePeriod } = await import("@/lib/archive/rotate");
const { appendEvent, SYSTEM_ACTOR } = await import("@/lib/audit/audit-log");
const { auditDb, prisma } = await import("@/lib/db");
const { AUDIT_ARCHIVE_DIRECTORY } = await import("@/lib/env");

let nextAccount = 0;

/** A superuser with an id no earlier case has used — `effectivePermissions` memoises per id. */
async function superuser() {
	nextAccount += 1;
	const id = `audit-action-${nextAccount}`;
	await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser: true } });
	const user = { id, name: id, email: `${id}@example.com`, isSuperuser: true, mustChangePassword: false };
	currentSessionUser.mockResolvedValue(user);
	return user;
}

/**
 * Leaves the install every upgrade from the storage foundation produced.
 *
 * Four events, the oldest two removed the way retention removed them before archiving existed — a raw
 * delete and an anchor on the newest row taken, with no file written and no epoch claimed, because
 * neither existed then — and then one archived period behind them, whose sweep claims the epoch on a
 * row whose predecessor is already gone.
 *
 * The rows are aged by appending them under a moved clock rather than by editing `at` afterwards: `at`
 * is one of the sixteen fields the chain hashes, so a backdated row reads as tampered — which is the
 * one finding this state exists to be told apart from.
 *
 * @returns the four events in `seq` order, as they stood before any of them was removed
 */
async function sweptBeforeArchiving() {
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-15T00:00:00Z") });
	try {
		for (const action of ["test:one", "test:two", "test:three", "test:four"]) {
			await appendEvent({ action, outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		}
	} finally {
		vi.useRealTimers();
	}

	const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
	await auditDb.auditEvent.deleteMany({ where: { seq: { lte: rows[1].seq } } });
	await auditDb.auditAnchor.create({ data: { id: 1, seq: rows[1].seq, hash: rows[1].hash } });

	// Archiving arrives, and the first sweep under it claims the epoch on the oldest row it covers —
	// which is where the record stops being an accusation and starts being a boundary.
	await archivePeriod({
		source: "audit",
		before: new Date("2026-02-01T00:00:00Z"),
		directory: AUDIT_ARCHIVE_DIRECTORY,
	});
	return rows;
}

beforeEach(async () => {
	await auditDb.auditEvent.deleteMany({});
	await auditDb.auditAnchor.deleteMany({});
	await auditDb.auditEpoch.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.account.deleteMany({});
	await prisma.user.deleteMany({});
	currentSessionUser.mockReset();
	// `archivePeriod` refuses to create the directory it writes into, so it is made here — and emptied
	// first, because a period left behind by an earlier case is a period the next walk would read.
	rmSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true, force: true });
	mkdirSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true });
});

afterAll(() => {
	rmSync(dirname(AUDIT_ARCHIVE_DIRECTORY), { recursive: true, force: true });
});

describe("verifyChain", () => {
	it("confirms an untouched chain", async () => {
		await superuser();
		await appendEvent({ action: "test:one", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const status = await verifyChain();

		expect(status.ok).toBe(true);
		expect(status.message).toContain("intact");
	});

	it("names the seq where an edited row breaks it", async () => {
		await superuser();
		await appendEvent({ action: "test:one", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await appendEvent({ action: "test:two", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		const first = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "asc" } });
		await auditDb.auditEvent.update({ where: { seq: first.seq }, data: { action: "test:edited" } });

		const status = await verifyChain();

		expect(status.ok).toBe(false);
		expect(status.message).toContain(`seq ${first.seq}`);
	});

	it("reports an incomplete chain without calling it broken", async () => {
		await superuser();
		const rows = await sweptBeforeArchiving();

		const status = await verifyChain();

		// Three states, and this is the middle one — asserted by value rather than for truthiness, which
		// could not tell it from a chain that verified all the way back. Goes red on either half of what
		// makes this state reachable at all: without the archive directory the walk answers `true`, and
		// without the epoch it answers `false` at the oldest archived row.
		expect(status.ok).toBe("incomplete");
		// And the words are not the failure's. A separate path to red from the assertion above: an
		// `"incomplete"` that falls through `describeVerification`'s three branches into the last one
		// keeps its state and is described as tampering anyway.
		expect(status.message).not.toContain("BROKEN");
		expect(status.message).not.toContain("changed after it was written");
		// Where verification starts is the whole of what makes this state different from a whole chain,
		// so the operator is told it rather than left with a colour.
		expect(status.message).toContain(`intact from seq ${rows[2].seq}`);
	});

	it("records that it ran", async () => {
		await superuser();

		await verifyChain();

		const row = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("audit:verify");
		expect(row.outcome).toBe("SUCCESS");
	});
});

describe("exportAuditCsv", () => {
	it("returns the filtered range as CSV", async () => {
		await superuser();
		await appendEvent({ action: "devices:delete", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await appendEvent({ action: "keys:create", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const result = await exportAuditCsv({ action: "devices:delete" });

		expect(result.error).toBeNull();
		expect(result.csv).toContain("devices:delete");
		expect(result.csv).not.toContain("keys:create");
	});

	it("records what was exported, not the export itself", async () => {
		await superuser();
		await appendEvent({ action: "devices:delete", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		await exportAuditCsv({ action: "devices:delete" });

		const row = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("audit:export");
		// The filter is in the row; the exported rows are not. A copy of the export inside the record
		// would double the table every time somebody pressed the button.
		expect(row.detail).toContain("devices:delete");
	});

	it("refuses a date it cannot parse rather than exporting everything", async () => {
		await superuser();
		await appendEvent({ action: "devices:delete", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const result = await exportAuditCsv({ from: "not-a-date" });

		expect(result.csv).toBeNull();
		expect(result.error).toContain("date");
	});

	it("refuses an outcome that is not one this system uses", async () => {
		await superuser();

		const result = await exportAuditCsv({ outcome: "MAYBE" });

		expect(result.csv).toBeNull();
		expect(result.error).toContain("outcome");
	});
});
