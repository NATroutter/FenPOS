import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendEvent, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { AUDIT_SWEEP_ACTION } from "@/lib/audit/system-actions";
import { auditDb, logsDb, prisma } from "@/lib/db";
import { AUDIT_ARCHIVE_DIRECTORY } from "@/lib/env";
import { logger } from "@/lib/logger";
import { archiveDirectory, runMaintenancePass } from "@/lib/maintenance/pass";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * `AUDIT_ARCHIVE_DIRECTORY` resolves to `data/archives`, which is where a developer's own audit
 * archives live — and this file exercises the pass for real, archives and all. Redirected at the one
 * module that owns the rule, so the pass under test still reads the constant it reads in production
 * and only the value differs. Anything else here is the real `lib/env.ts`.
 */
vi.mock("@/lib/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/env")>();
	const { mkdtempSync: makeTemp } = await import("node:fs");
	const { tmpdir: temp } = await import("node:os");
	const { join: joinPath } = await import("node:path");
	// A subdirectory of the temporary directory rather than the temporary directory itself, so it does
	// not exist until something creates it — which is what the first test below is about.
	return { ...actual, AUDIT_ARCHIVE_DIRECTORY: joinPath(makeTemp(joinPath(temp(), "fenpos-pass-")), "archives") };
});

/**
 * The pass that replaced two inline sweeps.
 *
 * Retention used to run on the way out of a write, so an install that stopped writing stopped
 * sweeping, and a print request paid for whatever the sweep did. It runs on a timer now. Two
 * properties matter more than "it sweeps", which the retention tests already cover: the directory
 * archives go into is provisioned by this module rather than assumed, and a failure in one half can
 * stop neither the other half nor the timer that drives them.
 */
describe("a maintenance pass", () => {
	beforeEach(async () => {
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
		await auditDb.auditEpoch.deleteMany({});
		await logsDb.logEntry.deleteMany({});
		await prisma.setting.deleteMany({});
		// This file exercises the log and audit halves only; the metrics half has its own test
		// (`test/lib/metrics/maintenance-metrics.test.ts`). Left on, every pass here would also run a
		// real rollup against whatever `Job`/`WebhookDelivery` rows other test files in this worker
		// happen to have left behind, and this file's own fake-clock jumps (`agedAuditPeriod`) would
		// send the rollup's watermark backwards and forwards across real time — turning an incidental
		// side effect into a slow, order-dependent backfill on every test.
		await setSetting("stats.enabled", false);
		rmSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		rmSync(dirname(AUDIT_ARCHIVE_DIRECTORY), { recursive: true, force: true });
	});

	/**
	 * Records `count` events through the real writer, so the fixtures are chained exactly as
	 * production rows are — `at` is one of the hashed fields, so a backdated row would fail the very
	 * chain check `archivePeriod` runs before it lets anything leave the live database.
	 */
	async function chain(count: number, prefix: string): Promise<void> {
		for (let index = 0; index < count; index++) {
			await appendEvent({ action: `${prefix}:${index}`, outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		}
	}

	/**
	 * Leaves three January events behind and moves the clock to March, with a one-day window — so
	 * January and February have both fully aged out by the time the caller runs a pass.
	 *
	 * The clock is left faked; `afterEach` restores it.
	 */
	async function agedAuditPeriod(): Promise<void> {
		// 1 is audit.retentionDays' declared minimum. Stored before the clock is faked, so the settings
		// row itself is written against the real one.
		await setSetting("audit.retentionDays", 1);
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-10T00:00:00Z") });
		await chain(3, "jan");
		vi.setSystemTime(new Date("2026-03-05T00:00:00Z"));
	}

	it("creates the archive directory rather than assuming somebody else did", async () => {
		// `archivePeriod` refuses to create its own directory — a mistyped path must fail before a row
		// is deleted, not after — so on an install that has never archived, this is the only thing
		// standing between the operator and a sweep that fails closed every hour forever.
		expect(existsSync(AUDIT_ARCHIVE_DIRECTORY)).toBe(false);

		expect(archiveDirectory()).toBe(AUDIT_ARCHIVE_DIRECTORY);
		expect(existsSync(AUDIT_ARCHIVE_DIRECTORY)).toBe(true);
	});

	it("archives an audit period that has fully aged out, and records that it did", async () => {
		await agedAuditPeriod();

		await runMaintenancePass();

		// The whole chain the pass is responsible for: it read `audit.retentionDays`, provisioned the
		// directory, and handed both to `sweepAuditNow`. Any missing link leaves the January rows live.
		expect(readdirSync(AUDIT_ARCHIVE_DIRECTORY)).toContain("audit-2026-01.db.gz");
		const live = await auditDb.auditEvent.findMany();
		expect(live.map((event) => event.action)).toEqual([AUDIT_SWEEP_ACTION]);
	});

	it("does not throw when a sweep fails", async () => {
		// The log half's first query with archiving on, which is the setting's built-in value. Injected
		// at the client rather than at `sweepLogsNow` itself, which is a named ESM export and cannot be
		// spied; what is asserted is the pass's behaviour, not that Prisma was called.
		vi.spyOn(logsDb.logEntry, "findFirst").mockRejectedValue(new Error("disk is gone"));
		const failed = vi.spyOn(logger, "error").mockImplementation(() => undefined);

		// Goes red the moment the pass lets a rejection escape: the interval that calls this has nobody
		// above it to catch one, and an unhandled rejection takes the container down.
		await expect(runMaintenancePass()).resolves.toBeUndefined();

		// The precondition, asserted rather than assumed. Injecting at the client means the failure only
		// happens if the pass reaches that query at all — if `logs.archiveEnabled`'s built-in value
		// flips, or `sweepLogsNow`'s archiving branch stops opening with this call, the assertion above
		// would still pass while proving only that a pass with nothing wrong in it resolves.
		expect(failed).toHaveBeenCalledWith("A log retention pass could not run", expect.any(Error));
	});

	it("sweeps the audit record even when the log sweep failed", async () => {
		vi.spyOn(logsDb.logEntry, "findFirst").mockRejectedValue(new Error("disk is gone"));
		const failed = vi.spyOn(logger, "error").mockImplementation(() => undefined);
		await agedAuditPeriod();

		await runMaintenancePass();

		// The same precondition: without this, a log half that quietly succeeded would leave this test
		// asserting that the audit half works when nothing went wrong, which is not what it is named.
		expect(failed).toHaveBeenCalledWith("A log retention pass could not run", expect.any(Error));
		// Goes red if the two halves share one try block: the audit record would stop being swept
		// because the log database had a bad day.
		expect(readdirSync(AUDIT_ARCHIVE_DIRECTORY)).toContain("audit-2026-01.db.gz");
	});

	it("does not throw when the archive directory cannot be created", async () => {
		const failed = vi.spyOn(logger, "error").mockImplementation(() => undefined);
		// A file where the directory should be: `mkdirSync` refuses this exactly as it would refuse a
		// read-only volume, and it is the one such failure a test can arrange for real. It happens
		// before either sweep starts, which is why the provisioning has to sit inside the guards rather
		// than above them — outside, the pass would reject and take an unwatched interval with it.
		writeFileSync(AUDIT_ARCHIVE_DIRECTORY, "not a directory");

		await expect(runMaintenancePass()).resolves.toBeUndefined();

		expect(failed).toHaveBeenCalledWith("A log retention pass could not run", expect.any(Error));
		expect(failed).toHaveBeenCalledWith("An audit retention pass could not run", expect.any(Error));
	});

	it("says which half failed rather than swallowing it", async () => {
		const failed = vi.spyOn(logger, "error").mockImplementation(() => undefined);
		vi.spyOn(auditDb.auditEvent, "findFirst").mockRejectedValue(new Error("audit.db is gone"));

		await expect(runMaintenancePass()).resolves.toBeUndefined();

		// The guard exists so an unattended timer cannot hang or crash, not so it can hide. A corrupt
		// `audit.retentionDays` makes `periodsFullyBefore` throw on purpose; a catch that logged nothing
		// would turn that deliberate refusal into a sweep that silently never happens again.
		expect(failed).toHaveBeenCalledWith("An audit retention pass could not run", expect.any(Error));
	});
});
