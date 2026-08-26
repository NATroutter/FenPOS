import { beforeEach, describe, expect, it } from "vitest";
import { appendEvent, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { sweepAuditNow } from "@/lib/audit/retention";
import { verifyAuditChain } from "@/lib/audit/verify";
import { prisma } from "@/lib/db";

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
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
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
		await prisma.auditEvent.updateMany({
			where: { seq: { in: seqs } },
			data: { at: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
		});
	}

	it("does nothing when the table is inside both bounds", async () => {
		await chain(3);

		expect(await sweepAuditNow({ retentionDays: 365, maxRecords: 100 })).toBeNull();
		expect(await prisma.auditEvent.count()).toBe(3);
		expect(await prisma.auditAnchor.findUnique({ where: { id: 1 } })).toBeNull();
	});

	it("removes the oldest down to the record cap", async () => {
		await chain(10);

		const outcome = await sweepAuditNow({ retentionDays: 365, maxRecords: 4 });

		expect(outcome?.removed).toBe(6);
		const rows = await prisma.auditEvent.findMany({ orderBy: { seq: "asc" } });
		expect(rows).toHaveLength(4);
		expect(rows[0].action).toBe("test:6");
	});

	it("leaves what survives verifiable", async () => {
		await chain(10);

		await sweepAuditNow({ retentionDays: 365, maxRecords: 4 });

		// The assertion the anchor exists for. Without the re-anchor this reports `anchor-mismatch` at
		// the oldest surviving row, because its `prevHash` names an event that is gone.
		const result = await verifyAuditChain(prisma);
		expect(result.ok).toBe(true);
	});

	it("anchors on the newest event it removed", async () => {
		await chain(10);
		const removed = await prisma.auditEvent.findMany({ orderBy: { seq: "asc" }, take: 6 });
		const last = removed[5];

		await sweepAuditNow({ retentionDays: 365, maxRecords: 4 });

		const anchor = await prisma.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });
		expect(anchor.seq).toBe(last.seq);
		expect(anchor.hash).toBe(last.hash);
	});

	it("removes events past the retention window even when the cap is not reached", async () => {
		await chain(5);
		const old = await prisma.auditEvent.findMany({ orderBy: { seq: "asc" }, take: 2 });
		await backdate(
			old.map((row) => row.seq),
			40,
		);

		const outcome = await sweepAuditNow({ retentionDays: 30, maxRecords: 100 });

		expect(outcome?.removed).toBe(2);
		expect(await prisma.auditEvent.count()).toBe(3);
	});

	it("takes the larger of the two bounds when both apply", async () => {
		await chain(10);
		const old = await prisma.auditEvent.findMany({ orderBy: { seq: "asc" }, take: 2 });
		await backdate(
			old.map((row) => row.seq),
			40,
		);

		// Age would remove 2, the cap would remove 6. Both are oldest-first, so the cap subsumes the
		// window and the answer is 6 — not 8, which is what adding them would give.
		const outcome = await sweepAuditNow({ retentionDays: 30, maxRecords: 4 });

		expect(outcome?.removed).toBe(6);
	});

	it("survives sweeping the table empty", async () => {
		await chain(3);

		const outcome = await sweepAuditNow({ retentionDays: 365, maxRecords: 0 });

		expect(outcome?.removed).toBe(3);
		expect(await prisma.auditEvent.count()).toBe(0);
		// Nothing to walk, and an anchor with no successor is not a break.
		expect((await verifyAuditChain(prisma)).ok).toBe(true);
	});

	it("re-anchors forward across a second sweep", async () => {
		await chain(10);
		await sweepAuditNow({ retentionDays: 365, maxRecords: 6 });
		const firstAnchor = await prisma.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });

		await sweepAuditNow({ retentionDays: 365, maxRecords: 2 });

		const secondAnchor = await prisma.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });
		// The anchor moves forward rather than a second row being written: `AuditAnchor` is one row by
		// construction, and a chain with two boundaries is one no verifier could walk.
		expect(secondAnchor.seq).toBeGreaterThan(firstAnchor.seq);
		expect((await verifyAuditChain(prisma)).ok).toBe(true);
	});
});
