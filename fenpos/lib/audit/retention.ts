import "server-only";
import { periodsFullyBefore } from "@/lib/archive/period";
import { archivePeriod } from "@/lib/archive/rotate";
import { claimEpoch } from "@/lib/audit/epoch";
import { auditDb } from "@/lib/db";

/**
 * Retention: home to the audit record's one deletion path, {@link removeAuditThrough}.
 *
 * There is no update path and no other delete path — not here, not in `audit-log.ts`, not in the
 * panel. That is what the `/audit` tab's missing edit and delete controls are telling the truth
 * about, and it is why `removeAuditThrough` is small enough to read in one sitting.
 *
 * **`sweepAuditNow` no longer deletes anything itself.** It resolves which whole calendar periods
 * have fully aged out and hands each to `lib/archive/rotate.ts`'s `archivePeriod`, which writes the
 * period to a file, verifies it, and only then calls `removeAuditThrough`. `removeAuditThrough` stays
 * in this module rather than moving to `rotate.ts` because it has a second caller that knows its
 * boundary as a `seq` — see its own doc comment — and because a single file holding the only function
 * that deletes is what lets `AuditAnchor` vouch for one boundary instead of two modules each thinking
 * they own it.
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
 * Archives every period that has fully aged out, then removes it.
 *
 * **This function no longer deletes anything itself.** It resolves which whole periods are older
 * than the window and hands each to `archivePeriod`, which writes the period file, verifies it —
 * including the hash chain — and only then calls {@link removeAuditThrough}. That ordering is the
 * one property the audit record cannot do without: history leaves the live database into a file, or
 * it does not leave at all.
 *
 * Whole periods rather than individual rows because an archive is named for a calendar month, and a
 * cutoff that fell inside one would file rows the operator was told were still live. The cost is
 * that up to one period more than `audit.retentionDays` is kept, which is stated in that setting's
 * own description.
 *
 * The epoch is claimed once the first due period's own archive is confirmed — not before, or a
 * directory that turns out not to exist would claim archived history begins at a row no file holds;
 * not after every period in this sweep, or a crash partway through a later one would leave rows
 * already archived-and-removed with nothing yet recording where that history starts. Only the first
 * sweep can answer where archived history begins — see `lib/audit/epoch.ts`.
 *
 * @param bounds `audit.retentionDays`, as configured
 * @param options where archives are written; the directory must already exist
 * @returns what this sweep removed and where the anchor now stands, or null when no period had fully
 *   aged out
 */
export async function sweepAuditNow(
	bounds: { retentionDays: number },
	options: { archiveDirectory: string },
): Promise<SweepOutcome | null> {
	const oldest = await auditDb.auditEvent.findFirst({
		orderBy: { seq: "asc" },
		select: { seq: true, at: true, prevHash: true },
	});
	if (!oldest) {
		return null;
	}

	const cutoff = new Date(Date.now() - bounds.retentionDays * 24 * 60 * 60 * 1000);
	const due = periodsFullyBefore(oldest.at, cutoff);
	if (due.length === 0) {
		return null;
	}

	let removed = 0;
	for (const [index, period] of due.entries()) {
		// Oldest first, and one at a time: each rotation removes a prefix of the chain, and a prefix
		// is the only shape an anchor can vouch for.
		const outcome = await archivePeriod({
			source: "audit",
			before: period.before,
			directory: options.archiveDirectory,
		});
		removed += outcome.rows;

		if (index === 0) {
			// Reached only once this period's archive is verified and its rows are already gone from
			// live — see the doc comment above for why this is neither earlier nor later than that.
			// `claimEpoch` writes once, ever, so calling it on every sweep that gets this far is
			// harmless: only the very first successful archive can actually set it.
			await claimEpoch(oldest.seq, oldest.prevHash);
		}
	}

	const anchor = await auditDb.auditAnchor.findUnique({ where: { id: 1 } });
	if (!anchor) {
		// Unreachable in practice: `due` is non-empty only because `oldest` exists, and `oldest`'s own
		// period is always the first one processed above, so its removal always upserts the anchor.
		// Thrown rather than silently defaulting a `seq`, because a caller reading `anchoredAt` from a
		// made-up number would believe a boundary exists that nothing backs.
		throw new Error("sweepAuditNow: expected an anchor after archiving a due period, but found none");
	}
	return { removed, anchoredAt: anchor.seq };
}

/**
 * Removes every event up to and including `boundarySeq`, and re-anchors the chain on it.
 *
 * The mechanism behind {@link sweepAuditNow}, exposed separately because it has a second caller that
 * knows its boundary as a `seq` rather than as an age. `lib/archive/rotate.ts` has already copied a
 * prefix of the chain into a period file and has to remove **exactly** the rows it copied; deriving a
 * retention window from that boundary and handing it back to `sweepAuditNow` would let the two
 * disagree about which rows are going, which is the one mistake neither caller may make.
 *
 * Taking a `seq` rather than a set of them is not a convenience: retention and rotation both remove a
 * prefix, because a chain with a hole anywhere but its oldest end cannot be vouched for by an anchor —
 * see the module comment above. `lte` is what makes that structural rather than a caller's promise.
 *
 * @param boundarySeq the newest event to remove; 0 when there is nothing to remove
 * @returns what was removed, or null when the boundary names nothing
 */
export async function removeAuditThrough(boundarySeq: number): Promise<SweepOutcome | null> {
	if (boundarySeq === 0) {
		return null;
	}

	// Read before the delete, and read for its hash: this row is about to stop existing, and its hash
	// is the only thing that will let the row after it still verify.
	const last = await auditDb.auditEvent.findUnique({ where: { seq: boundarySeq }, select: { seq: true, hash: true } });
	if (!last) {
		return null;
	}

	return await auditDb.$transaction(async (tx) => {
		const removed = await tx.auditEvent.deleteMany({ where: { seq: { lte: boundarySeq } } });
		await tx.auditAnchor.upsert({
			where: { id: 1 },
			update: { seq: last.seq, hash: last.hash },
			create: { id: 1, seq: last.seq, hash: last.hash },
		});
		return { removed: removed.count, anchoredAt: last.seq };
	});
}
