import "server-only";
import { prisma } from "@/lib/db";

/**
 * Retention: the only deletion the audit record has, anywhere.
 *
 * There is no update path and no other delete path — not here, not in `audit-log.ts`, not in the
 * panel. That is what the `/audit` tab's missing edit and delete controls are telling the truth
 * about, and it is why this module is small enough to read in one sitting.
 *
 * **Oldest-first, always, and re-anchored behind itself.** Removing from anywhere but the oldest end
 * would break the chain irreparably: every surviving row after the gap links to something that is
 * gone, and no anchor can vouch for more than one boundary. Removing from the oldest end leaves
 * exactly one such boundary, and `AuditAnchor` is what vouches for it — the last swept event's `seq`
 * and `hash`, which `verifyAuditChain` starts its walk from.
 *
 * **This module writes no audit row.** The sweep's own row is written by `audit-log.ts`, which calls
 * this and then appends. Keeping the dependency one-way is what stops the two modules from importing
 * each other, and stops a sweep's row from triggering another sweep.
 */

/** What one sweep did. */
export interface SweepOutcome {
	/** How many events were removed. Always at least one — a sweep that removes nothing returns null. */
	removed: number;
	/** The `seq` the anchor now names: the newest event this sweep removed. */
	anchoredAt: number;
}

/**
 * Removes the oldest events until the table is inside both bounds, and re-anchors the chain.
 *
 * The two bounds are both oldest-first, so they do not add: whichever reaches further into the table
 * subsumes the other, and the boundary is the higher of the two `seq` values. Adding them would
 * remove rows twice over.
 *
 * The delete and the anchor write go in one transaction. Separately, a crash between them leaves
 * either a chain whose oldest row links to something gone with no anchor to vouch for it, or an
 * anchor naming an event that is still present — and the first of those reads, to
 * `verifyAuditChain`, as tampering.
 *
 * @param bounds `audit.retentionDays` and `audit.maxRecords`, as configured
 * @returns what the sweep did, or null when the table was already inside both bounds
 */
export async function sweepAuditNow(bounds: {
	retentionDays: number;
	maxRecords: number;
}): Promise<SweepOutcome | null> {
	const boundary = Math.max(await ageBoundary(bounds.retentionDays), await countBoundary(bounds.maxRecords));
	if (boundary === 0) {
		return null;
	}

	// Read before the delete, and read for its hash: this row is about to stop existing, and its hash
	// is the only thing that will let the row after it still verify.
	const last = await prisma.auditEvent.findUnique({ where: { seq: boundary }, select: { seq: true, hash: true } });
	if (!last) {
		return null;
	}

	return await prisma.$transaction(async (tx) => {
		const removed = await tx.auditEvent.deleteMany({ where: { seq: { lte: boundary } } });
		await tx.auditAnchor.upsert({
			where: { id: 1 },
			update: { seq: last.seq, hash: last.hash },
			create: { id: 1, seq: last.seq, hash: last.hash },
		});
		return { removed: removed.count, anchoredAt: last.seq };
	});
}

/**
 * The newest `seq` that is older than the retention window.
 *
 * @param retentionDays how long an event is kept
 * @returns that `seq`, or 0 when nothing has aged out
 */
async function ageBoundary(retentionDays: number): Promise<number> {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	const oldest = await prisma.auditEvent.findFirst({
		where: { at: { lt: cutoff } },
		orderBy: { seq: "desc" },
		select: { seq: true },
	});
	return oldest?.seq ?? 0;
}

/**
 * The newest `seq` that has to go for the table to fit under the record cap.
 *
 * @param maxRecords rows kept before the oldest are swept
 * @returns that `seq`, or 0 when the table already fits
 */
async function countBoundary(maxRecords: number): Promise<number> {
	const total = await prisma.auditEvent.count();
	if (total <= maxRecords) {
		return 0;
	}

	// The last row of the excess, found by skipping to it rather than by loading the excess: on an
	// install that has been running a year the excess is the larger half of the table.
	const excess = total - maxRecords;
	const last = await prisma.auditEvent.findMany({
		orderBy: { seq: "asc" },
		skip: excess - 1,
		take: 1,
		select: { seq: true },
	});
	return last[0]?.seq ?? 0;
}
