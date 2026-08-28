import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendEvent, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { readEpoch } from "@/lib/audit/epoch";
import { sweepAuditNow } from "@/lib/audit/retention";
import { verifyAuditChain } from "@/lib/audit/verify";
import { auditDb } from "@/lib/db";

/**
 * The retention sweep: one of the two things that can remove audit rows, and the only one that runs
 * unattended. `deleteAuditArchive` (`app/(panel)/archives/actions.ts`) is the other, gated by
 * `audit:archive-delete` and reached only by a person's deliberate choice — not exercised here.
 *
 * The property under test is not "old rows go away" — that is easy and uninteresting. It is that
 * what survives a sweep still verifies, which is the whole reason `AuditAnchor` exists: the oldest
 * surviving row's `prevHash` names an event that is no longer in the table, and only the anchor can
 * vouch for it. On top of that, since `sweepAuditNow` now archives before it deletes, every test here
 * ages rows by moving a faked clock forward rather than by backdating `at` with a raw update — `at` is
 * one of the sixteen hashed fields, and a mutated row would fail the very chain check `archivePeriod`
 * runs before it lets a row leave the live database.
 */
describe("sweepAuditNow", () => {
	beforeEach(async () => {
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
		await auditDb.auditEpoch.deleteMany({});
	});

	/**
	 * Records `count` events through the real writer, so the fixtures are chained exactly as
	 * production rows are.
	 *
	 * `appendEvent` rather than `recordAudit` because that is the name a writer outside a request
	 * says; the two do the same thing now that retention has left the write path. `prefix` lets a test
	 * tell which period a surviving row came from without relying on a shared counter across calls.
	 */
	async function chain(count: number, prefix = "test"): Promise<void> {
		for (let index = 0; index < count; index++) {
			await appendEvent({ action: `${prefix}:${index}`, outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		}
	}

	/**
	 * A fresh directory for one test's archives, removed when the callback finishes.
	 *
	 * `archivePeriod` requires the directory to exist and refuses to write over a period it has
	 * already archived, so a directory shared across tests would make two tests that both age a row
	 * into "2026-01" collide with each other.
	 */
	async function withArchiveDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
		const directory = mkdtempSync(join(tmpdir(), "fenpos-sweep-"));
		try {
			return await run(directory);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	it("does nothing when the table is inside the retention window", async () => {
		await chain(3);

		await withArchiveDirectory(async (directory) => {
			expect(await sweepAuditNow({ retentionDays: 365 }, { archiveDirectory: directory })).toBeNull();
		});
		expect(await auditDb.auditEvent.count()).toBe(3);
		expect(await auditDb.auditAnchor.findUnique({ where: { id: 1 } })).toBeNull();
	});

	it("archives every period that has fully aged out, summing the removal count across periods", async () => {
		await withArchiveDirectory(async (directory) => {
			try {
				vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-10T00:00:00Z") });
				await chain(3, "jan");
				vi.setSystemTime(new Date("2026-02-10T00:00:00Z"));
				await chain(2, "feb");
				vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));
				await chain(4, "may");

				const outcome = await sweepAuditNow({ retentionDays: 30 }, { archiveDirectory: directory });

				// January and February are both fully aged out — and the empty month between them still
				// counts as a due period, so the sum has to cross more than one `archivePeriod` call. That
				// crossing is exactly what the accumulation in `sweepAuditNow` exists for.
				expect(outcome?.removed).toBe(5);
				expect(await auditDb.auditEvent.count()).toBe(4);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	it("leaves what survives verifiable", async () => {
		await withArchiveDirectory(async (directory) => {
			try {
				vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-10T00:00:00Z") });
				await chain(6, "jan");
				vi.setSystemTime(new Date("2026-03-10T00:00:00Z"));
				await chain(4, "mar");

				await sweepAuditNow({ retentionDays: 30 }, { archiveDirectory: directory });

				// No `archiveDirectory` passed here: only the live segment is walked, against the anchor
				// `removeAuditThrough` wrote. Without the re-anchor this reports `anchor-mismatch` at the
				// oldest surviving row, because its `prevHash` names an event that is gone.
				const result = await verifyAuditChain(auditDb);
				expect(result.ok).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	it("anchors on the newest event it removed", async () => {
		await withArchiveDirectory(async (directory) => {
			try {
				vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-10T00:00:00Z") });
				await chain(6, "jan");
				const jan = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" }, take: 6 });
				vi.setSystemTime(new Date("2026-03-10T00:00:00Z"));
				await chain(4, "mar");

				await sweepAuditNow({ retentionDays: 30 }, { archiveDirectory: directory });

				const anchor = await auditDb.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });
				expect(anchor.seq).toBe(jan[5].seq);
				expect(anchor.hash).toBe(jan[5].hash);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	it("removes events past the retention window, leaving the surviving period's own rows", async () => {
		await withArchiveDirectory(async (directory) => {
			try {
				vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-10T00:00:00Z") });
				await chain(2, "jan");
				vi.setSystemTime(new Date("2026-03-10T00:00:00Z"));
				await chain(3, "mar");

				const outcome = await sweepAuditNow({ retentionDays: 30 }, { archiveDirectory: directory });

				expect(outcome?.removed).toBe(2);
				const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
				expect(rows).toHaveLength(3);
				expect(rows.every((row) => row.action.startsWith("mar:"))).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	it("survives sweeping the table empty", async () => {
		await withArchiveDirectory(async (directory) => {
			try {
				vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-10T00:00:00Z") });
				await chain(3, "jan");
				vi.setSystemTime(new Date("2027-02-05T00:00:00Z"));

				const outcome = await sweepAuditNow({ retentionDays: 365 }, { archiveDirectory: directory });

				expect(outcome?.removed).toBe(3);
				expect(await auditDb.auditEvent.count()).toBe(0);
				// Nothing to walk, and an anchor with no successor is not a break.
				expect((await verifyAuditChain(auditDb)).ok).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	it("re-anchors forward across a second sweep", async () => {
		await withArchiveDirectory(async (directory) => {
			try {
				vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-10T00:00:00Z") });
				await chain(3, "jan");
				vi.setSystemTime(new Date("2026-02-10T00:00:00Z"));
				await chain(2, "feb");
				vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
				await chain(1, "apr");

				await sweepAuditNow({ retentionDays: 30 }, { archiveDirectory: directory });
				const firstAnchor = await auditDb.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });

				vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));
				await sweepAuditNow({ retentionDays: 30 }, { archiveDirectory: directory });
				const secondAnchor = await auditDb.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });

				// The anchor moves forward rather than a second row being written: `AuditAnchor` is one row
				// by construction, and a chain with two boundaries is one no verifier could walk.
				expect(secondAnchor.seq).toBeGreaterThan(firstAnchor.seq);
				expect((await verifyAuditChain(auditDb)).ok).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	it("keeps the chain verifiable after an age-based sweep, whatever the volume", async () => {
		await withArchiveDirectory(async (directory) => {
			try {
				vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-10T00:00:00Z") });
				await chain(5, "jan");
				vi.setSystemTime(new Date("2026-03-10T00:00:00Z"));
				await chain(35, "mar");

				const outcome = await sweepAuditNow({ retentionDays: 30 }, { archiveDirectory: directory });

				expect(outcome?.removed).toBe(5);
				const verified = await verifyAuditChain(auditDb);
				expect(verified.ok).toBe(true);
				// Volume alone must never sweep: all 35 rows inside the window remain.
				expect(verified.checked).toBe(35);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	it("archives a fully aged-out period before removing it, and claims the epoch", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fenpos-sweep-"));
		try {
			// Appended under a fake clock so `at` is genuinely old: `lib/audit/append.ts` stamps it from
			// `new Date()`, and mutating it afterwards would break the hash the archive is verified by.
			vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-15T00:00:00Z") });
			for (let index = 0; index < 3; index += 1) {
				await appendEvent({ action: "audit:sweep", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
			}
			vi.setSystemTime(new Date("2026-03-10T00:00:00Z"));
			for (let index = 0; index < 2; index += 1) {
				await appendEvent({ action: "audit:sweep", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
			}

			const archived = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" }, take: 3 });

			// 2026-01 is fully older than the cutoff; 2026-03 is the cutoff's own period and must survive.
			vi.setSystemTime(new Date("2026-03-20T00:00:00Z"));
			const outcome = await sweepAuditNow({ retentionDays: 30 }, { archiveDirectory: directory });

			expect(outcome?.removed).toBe(3);
			expect(existsSync(join(directory, "audit-2026-01.db.gz"))).toBe(true);
			expect(await auditDb.auditEvent.count()).toBe(2);

			// The epoch names the oldest row archiving covered, so verification can tell this history
			// from history nobody kept. Goes red if the sweep deletes without claiming it.
			expect(await readEpoch()).toEqual({ seq: archived[0].seq, prevHash: archived[0].prevHash });

			const verified = await verifyAuditChain(auditDb, { archiveDirectory: directory });
			expect(verified.ok).toBe(true);
			expect(verified.checked).toBe(5);
		} finally {
			vi.useRealTimers();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("removes nothing when the archive cannot be written", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-15T00:00:00Z") });
		try {
			await appendEvent({ action: "audit:sweep", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
			vi.setSystemTime(new Date("2026-03-20T00:00:00Z"));

			// The specific message, not a bare `.toThrow()`: a bare matcher would pass equally well on
			// an early argument check that proved nothing about ordering. This pins the failure to the
			// archive write itself — `new Database(path)` in `lib/archive/rotate.ts`'s `intoArchive`,
			// the same failure `rotate.test.ts` pins for `archivePeriod` directly.
			await expect(
				sweepAuditNow({ retentionDays: 30 }, { archiveDirectory: join("/does/not/exist", "archives") }),
			).rejects.toThrow(/directory does not exist/i);

			// The property this task exists for: the audit record is never deleted unarchived. Goes red
			// the moment the sweep deletes first and archives afterwards.
			expect(await auditDb.auditEvent.count()).toBe(1);
			expect(await readEpoch()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
