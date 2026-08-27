import "server-only";
import { auditDb } from "@/lib/db";

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
 * Removes events older than the retention window, and re-anchors the chain.
 *
 * By age alone, not by row count: audit is negligible in size — ~500-650 B a row, so even a busy
 * install adds tens of megabytes a year — so there is no volume an operator needs protecting from,
 * only a window of history they want kept. A count cap would evict by volume instead, and a burst of
 * two hundred actions in one hour could silently destroy the year before it.
 *
 * The delete and the anchor write go in one transaction, and can: both tables live in `audit.db`,
 * so this is one file's transaction rather than a promise spanning two. Separately, a crash between
 * them leaves either a chain whose oldest row links to something gone with no anchor to vouch for
 * it, or an anchor naming an event that is still present — and the first of those reads, to
 * `verifyAuditChain`, as tampering.
 *
 * @param bounds `audit.retentionDays`, as configured
 * @returns what the sweep did, or null when nothing has aged out
 */
export async function sweepAuditNow(bounds: { retentionDays: number }): Promise<SweepOutcome | null> {
	const boundary = await ageBoundary(bounds.retentionDays);
	if (boundary === 0) {
		return null;
	}

	// Read before the delete, and read for its hash: this row is about to stop existing, and its hash
	// is the only thing that will let the row after it still verify.
	const last = await auditDb.auditEvent.findUnique({ where: { seq: boundary }, select: { seq: true, hash: true } });
	if (!last) {
		return null;
	}

	return await auditDb.$transaction(async (tx) => {
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
	const oldest = await auditDb.auditEvent.findFirst({
		where: { at: { lt: cutoff } },
		orderBy: { seq: "desc" },
		select: { seq: true },
	});
	return oldest?.seq ?? 0;
}
