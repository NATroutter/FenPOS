import { beforeEach, describe, expect, it } from "vitest";
import { appendEvent, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { sweepAuditNow } from "@/lib/audit/retention";
import { verifyAuditChain } from "@/lib/audit/verify";
import { auditDb } from "@/lib/db";

/**
 * The only deletion the audit record has.
 *
 * The property under test is not "old rows go away" — that is easy and uninteresting. It is that
 * what survives a sweep still verifies, which is the whole reason `AuditAnchor` exists: the oldest
 * surviving row's `prevHash` names an event that is no longer in the table, and only the anchor can
 * vouch for it.
 */
describe("sweepAuditNow", () => {
	beforeEach(async () => {
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
	});

	/**
	 * Records `count` events through the real writer, so the fixtures are chained exactly as
	 * production rows are.
	 *
	 * `appendEvent` rather than `recordAudit`, so building a fixture cannot itself trigger a sweep.
	 */
	async function chain(count: number): Promise<void> {
		for (let index = 0; index < count; index++) {
			await appendEvent({ action: `test:${index}`, outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		}
	}

	/**
	 * Backdates rows past a retention window.
	 *
	 * A raw update, which breaks those rows' hashes — acceptable only because every row it touches is
	 * about to be deleted, and what verifies afterwards is the anchor plus what survived. Never use
	 * this on a row a sweep is then asked to keep.
	 *
	 * @param seqs the rows to backdate
	 * @param days how far back to move them
	 */
	async function backdate(seqs: number[], days: number): Promise<void> {
		await auditDb.auditEvent.updateMany({
			where: { seq: { in: seqs } },
			data: { at: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
		});
	}

	it("does nothing when the table is inside the retention window", async () => {
		await chain(3);

		expect(await sweepAuditNow({ retentionDays: 365 })).toBeNull();
		expect(await auditDb.auditEvent.count()).toBe(3);
		expect(await auditDb.auditAnchor.findUnique({ where: { id: 1 } })).toBeNull();
	});

	it("removes exactly the events older than the window", async () => {
		await chain(10);
		const old = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" }, take: 6 });
		await backdate(
			old.map((row) => row.seq),
			40,
		);

		const outcome = await sweepAuditNow({ retentionDays: 30 });

		expect(outcome?.removed).toBe(6);
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		expect(rows).toHaveLength(4);
		expect(rows[0].action).toBe("test:6");
	});

	it("leaves what survives verifiable", async () => {
		await chain(10);
		const old = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" }, take: 6 });
		await backdate(
			old.map((row) => row.seq),
			40,
		);

		await sweepAuditNow({ retentionDays: 30 });

		// The assertion the anchor exists for. Without the re-anchor this reports `anchor-mismatch` at
		// the oldest surviving row, because its `prevHash` names an event that is gone.
		const result = await verifyAuditChain(auditDb);
		expect(result.ok).toBe(true);
	});

	it("anchors on the newest event it removed", async () => {
		await chain(10);
		const removed = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" }, take: 6 });
		const last = removed[5];
		await backdate(
			removed.map((row) => row.seq),
			40,
		);

		await sweepAuditNow({ retentionDays: 30 });

		const anchor = await auditDb.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });
		expect(anchor.seq).toBe(last.seq);
		expect(anchor.hash).toBe(last.hash);
	});

	it("removes events past the retention window", async () => {
		await chain(5);
		const old = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" }, take: 2 });
		await backdate(
			old.map((row) => row.seq),
			40,
		);

		const outcome = await sweepAuditNow({ retentionDays: 30 });

		expect(outcome?.removed).toBe(2);
		expect(await auditDb.auditEvent.count()).toBe(3);
	});

	it("survives sweeping the table empty", async () => {
		await chain(3);
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		await backdate(
			rows.map((row) => row.seq),
			400,
		);

		const outcome = await sweepAuditNow({ retentionDays: 365 });

		expect(outcome?.removed).toBe(3);
		expect(await auditDb.auditEvent.count()).toBe(0);
		// Nothing to walk, and an anchor with no successor is not a break.
		expect((await verifyAuditChain(auditDb)).ok).toBe(true);
	});

	it("re-anchors forward across a second sweep", async () => {
		await chain(10);
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		await backdate(
			rows.slice(0, 6).map((row) => row.seq),
			40,
		);

		await sweepAuditNow({ retentionDays: 30 });
		const firstAnchor = await auditDb.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });

		await backdate(
			rows.slice(6, 8).map((row) => row.seq),
			40,
		);
		await sweepAuditNow({ retentionDays: 30 });

		const secondAnchor = await auditDb.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });
		// The anchor moves forward rather than a second row being written: `AuditAnchor` is one row by
		// construction, and a chain with two boundaries is one no verifier could walk.
		expect(secondAnchor.seq).toBeGreaterThan(firstAnchor.seq);
		expect((await verifyAuditChain(auditDb)).ok).toBe(true);
	});

	it("keeps the chain verifiable after an age-based sweep, whatever the volume", async () => {
		for (let index = 0; index < 40; index += 1) {
			await appendEvent({ action: "audit:sweep", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		}
		// `seq` is a real SQLite AUTOINCREMENT column (backed by sqlite_sequence), so it climbs across
		// every test in this file rather than resetting to 1 when `beforeEach` empties the table. The
		// oldest five rows of *this* run are found by ordering rather than assumed to be seq 1-5.
		const oldest = await auditDb.auditEvent.findMany({
			orderBy: { seq: "asc" },
			take: 5,
			select: { seq: true },
		});
		// A raw update rather than the `backdate` helper above — safe for the same reason `backdate`
		// is: every row touched here is removed by the sweep below before anything hash-verifies it,
		// and `verifyAuditChain` checks the surviving chain against the anchor's *stored* hash for the
		// removed boundary row, never a recomputed one. So mutating `at` — one of `CANONICAL_FIELDS`
		// the hash covers — never surfaces as a hash mismatch. This is safe only because these rows are
		// deleted before verification; it would not be safe to do this to a row a sweep is asked to
		// keep.
		await auditDb.auditEvent.updateMany({
			where: { seq: { in: oldest.map((row) => row.seq) } },
			data: { at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
		});

		const outcome = await sweepAuditNow({ retentionDays: 365 });

		expect(outcome?.removed).toBe(5);
		const verified = await verifyAuditChain(auditDb);
		expect(verified.ok).toBe(true);
		// Volume alone must never sweep: 35 rows remain inside the window.
		expect(verified.checked).toBe(35);
	});
});
