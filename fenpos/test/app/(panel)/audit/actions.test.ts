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

const { auditArchiveCovering, exportAuditCsv, listMoreAuditEvents, verifyChain } = await import(
	"@/app/(panel)/audit/actions"
);
const { archivePeriod } = await import("@/lib/archive/rotate");
const { appendEvent, SYSTEM_ACTOR } = await import("@/lib/audit/audit-log");
const { auditDb, logsDb, prisma } = await import("@/lib/db");
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

/** An account holding exactly the permissions named, with an id no earlier case has used. */
async function account(permissions: string[]) {
	nextAccount += 1;
	const id = `audit-action-${nextAccount}`;
	await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser: false } });
	for (const permission of permissions) {
		await prisma.userPermission.create({ data: { userId: id, permission } });
	}
	const user = { id, name: id, email: `${id}@example.com`, isSuperuser: false, mustChangePassword: false };
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

/**
 * Puts a real audit archive for one month on disk, by recording an event in it and rotating.
 *
 * The clock is moved rather than the row backdated, for the reason {@link sweptBeforeArchiving} gives:
 * `at` is one of the sixteen fields the chain hashes. Rotation would refuse to delete a prefix that did
 * not verify, so an archive that exists here is one the whole pipeline actually produced.
 *
 * @param at when the archived event happened
 * @param before the first instant after the period, which is what names the archive
 */
async function archivedAuditMonth(at: Date, before: Date): Promise<void> {
	vi.useFakeTimers({ toFake: ["Date"], now: at });
	try {
		await appendEvent({ action: "test:archived", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
	} finally {
		vi.useRealTimers();
	}
	await archivePeriod({ source: "audit", before, directory: AUDIT_ARCHIVE_DIRECTORY });
}

/**
 * Puts a real log archive for one month on disk, the same way.
 *
 * Rotated rather than written as an empty file with the right name, so what these cases see is a
 * `logs-<period>.db.gz` the log half genuinely produced — which is the file an audit reader must not be
 * pointed at.
 *
 * @param at when the archived line was recorded
 * @param before the first instant after the period
 */
async function archivedLogMonth(at: Date, before: Date): Promise<void> {
	await logsDb.logEntry.create({ data: { level: "INFO", severity: 1, message: "archived line", ts: at } });
	await archivePeriod({ source: "logs", before, directory: AUDIT_ARCHIVE_DIRECTORY });
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

	it("exports the same rows a multi-select filter shows", async () => {
		await superuser();
		await appendEvent({ action: "devices:delete", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await appendEvent({ action: "keys:create", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await appendEvent({ action: "jobs:read", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		// The tab's dropdowns are multi-select and put several values in one parameter. An export that
		// read that parameter differently from the table above it would hand back a different set of
		// rows than the one on screen, which is why both go through `parseValues`.
		const result = await exportAuditCsv({ action: "devices:delete,keys:create" });

		expect(result.error).toBeNull();
		expect(result.csv).toContain("devices:delete");
		expect(result.csv).toContain("keys:create");
		expect(result.csv).not.toContain("jobs:read");
	});

	it("refuses when any one of several outcomes is not one this system uses", async () => {
		await superuser();

		const result = await exportAuditCsv({ outcome: "SUCCESS,MAYBE" });

		expect(result.csv).toBeNull();
		expect(result.error).toContain("outcome");
	});
});

/**
 * The Audit tab's signpost.
 *
 * The tab has `from`/`to` filters and the record now archives instead of deleting, so a range that
 * reaches back past the live window returns an empty table over rows that are sitting in an
 * `audit-*.db.gz`. Before this branch that table was truthful; it is not any more, which is what makes
 * this the same affordance the Logs tab already had rather than an ornament copied onto a second page.
 *
 * Every fixture here is a real archive, rotated by `archivePeriod` into the mocked directory, so what
 * these cases read is what the maintenance pass actually leaves on disk.
 */
describe("auditArchiveCovering", () => {
	it("offers the archive covering a range that starts before the live window", async () => {
		await superuser();
		await archivedAuditMonth(new Date("2026-03-15T00:00:00Z"), new Date("2026-04-01T00:00:00Z"));

		const covering = await auditArchiveCovering({
			from: new Date("2026-03-05T00:00:00.000Z"),
			to: new Date("2026-03-20T00:00:00.000Z"),
		});

		// Goes red when a range reaching into an archived period is answered with nothing, which is the
		// half of the signpost that lives in this function. The other half is the page's: it asks only
		// when a range was filtered on and renders nothing when the answer is null.
		expect(covering).toBe("2026-03");
	});

	it("does not offer a log archive to a reader of the record", async () => {
		await superuser();
		// The same month, from the other database. An implementation matching on the period alone — or on
		// the filename rather than the parsed `source` — offers this one, which points somebody holding
		// `audit:read` and possibly nothing else at the log.
		await archivedLogMonth(new Date("2026-03-15T00:00:00Z"), new Date("2026-04-01T00:00:00Z"));
		const range = {
			from: new Date("2026-03-01T00:00:00.000Z"),
			to: new Date("2026-03-31T23:59:59.999Z"),
		};

		expect(await auditArchiveCovering(range)).toBeNull();

		// And the null above is an answer rather than the only answer this function has: the audit archive
		// for exactly that month is offered as soon as there is one. Without this second half a mutation
		// that always returned null would pass the assertion above.
		await archivedAuditMonth(new Date("2026-03-15T00:00:00Z"), new Date("2026-04-01T00:00:00Z"));

		expect(await auditArchiveCovering(range)).toBe("2026-03");
	});

	it("does not offer an archived month the range never asked about", async () => {
		await superuser();
		await archivedAuditMonth(new Date("2026-09-15T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));

		// September is after the range ends, and an archive outside the range holds nothing that was asked
		// for — a signpost pointing at data the operator did not ask about is worse than none.
		expect(
			await auditArchiveCovering({
				from: new Date("2026-03-01T00:00:00.000Z"),
				to: new Date("2026-03-31T23:59:59.999Z"),
			}),
		).toBeNull();

		// The teeth on the assertion above: widen the range to reach September and the same archive is
		// offered, so the null was the range being consulted rather than the archive being invisible.
		expect(
			await auditArchiveCovering({
				from: new Date("2026-03-01T00:00:00.000Z"),
				to: new Date("2026-09-30T23:59:59.999Z"),
			}),
		).toBe("2026-09");
	});

	it("stays quiet in the record about having been asked", async () => {
		await superuser();
		await archivedAuditMonth(new Date("2026-03-15T00:00:00Z"), new Date("2026-04-01T00:00:00Z"));
		// The one event this test wrote is now in the archive, so the live table is empty and any row
		// found afterwards was written by the call below and by nothing else.
		expect(await auditDb.auditEvent.count()).toBe(0);

		expect(await auditArchiveCovering({ from: new Date("2026-03-05T00:00:00.000Z") })).toBe("2026-03");

		// Registered `query`, not `command`, and this is what that buys: the page asks on every render of
		// a filtered view, so a recorded success would be a row per page load, and the rows worth reading
		// would be buried under them. Goes red if the entry's `kind` becomes `command`.
		expect(await auditDb.auditEvent.count()).toBe(0);
	});
});

/**
 * The Audit tab's infinite scroll action.
 *
 * `permission-matrix.test.ts` already proves the gate itself is consulted; what is left here is that
 * the body narrows exactly as `listAuditEvents` would from the page's own `searchParams`, that a
 * hostile offset cannot reach it unclamped, and that a scroll writes nothing to the record it reads.
 */
describe("listMoreAuditEvents", () => {
	it("refuses a caller without audit:read, and records the refusal", async () => {
		await account([]);

		const batch = await listMoreAuditEvents({ offset: 0 });

		expect(batch.events).toEqual([]);
		expect(batch.more).toBe(false);
		expect(batch.error).toContain("permission");
		const row = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("audit:list-more");
		expect(row.outcome).toBe("DENIED");
	});

	it("returns the batch starting at the given offset", async () => {
		await account(["audit:read"]);
		await appendEvent({ action: "test:one", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await appendEvent({ action: "test:two", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const first = await listMoreAuditEvents({ offset: 0 });
		expect(first.events).toHaveLength(2);
		expect(first.more).toBe(false);
		expect(first.error).toBeNull();

		const second = await listMoreAuditEvents({ offset: first.events.length });
		expect(second.events).toEqual([]);
	});

	it("narrows by several actions at once, the way the multi-select dropdown sends them", async () => {
		await account(["audit:read"]);
		await appendEvent({ action: "devices:delete", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await appendEvent({ action: "keys:create", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const batch = await listMoreAuditEvents({ offset: 0, action: "devices:delete,keys:create" });

		expect(batch.events.map((event) => event.action).sort()).toEqual(["devices:delete", "keys:create"]);
	});

	it("drops an outcome this system does not use rather than erroring", async () => {
		await account(["audit:read"]);
		await appendEvent({ action: "test:one", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		// Deliberately not the strict reading `exportAuditCsv`'s own parser takes — see
		// `search-params.ts`'s doc for why this one drops rather than throws.
		const batch = await listMoreAuditEvents({ offset: 0, outcome: "NOT_AN_OUTCOME" });

		expect(batch.error).toBeNull();
		expect(batch.events).toHaveLength(1);
	});

	it("clamps a hostile offset rather than handing it to the database unclamped", async () => {
		await account(["audit:read"]);
		await appendEvent({ action: "test:one", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await appendEvent({ action: "test:two", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const batch = await listMoreAuditEvents({ offset: { not: "a number" } });

		expect(batch.error).toBeNull();
		expect(batch.events).toHaveLength(2);
	});

	it("does not record a success, so a scroll does not bury the tab's own commands", async () => {
		await account(["audit:read"]);
		await appendEvent({ action: "test:one", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		await listMoreAuditEvents({ offset: 0 });

		const row = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("test:one");
	});
});
