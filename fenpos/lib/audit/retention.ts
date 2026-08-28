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
 * in this module — `archivePeriod` is its only caller now — because a single file holding the only
 * function that deletes is what lets `AuditAnchor` vouch for one boundary instead of two modules each
 * thinking they own it.
 *
 * **Oldest-first, always, and re-anchored behind itself.** Removing from anywhere but the oldest end
 * would break the chain irreparably: every surviving row after the gap links to something that is
 * gone, and no anchor can vouch for more than one boundary. Removing from the oldest end leaves
 * exactly one such boundary, and `AuditAnchor` is what vouches for it — the last swept event's `seq`
 * and `hash`, which `verifyAuditChain` starts its walk from.
 *
 * **This module writes no audit row.** The sweep's own `audit:sweep` row is written by
 * `lib/maintenance/pass.ts`, which calls this and then appends. Keeping the dependency one-way is
 * what stops this module and `audit-log.ts` from importing each other.
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
 * Only `oldest.at` is read here, not its `seq` or `prevHash`: this function no longer claims the
 * epoch itself. `removeAuditThrough` does, from inside the same transaction as the delete it
 * protects — see that function's doc comment for why the claim belongs there instead of here.
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
		select: { at: true },
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
	for (const period of due) {
		// Oldest first, and one at a time: each rotation removes a prefix of the chain, and a prefix
		// is the only shape an anchor can vouch for.
		const outcome = await archivePeriod({
			source: "audit",
			before: period.before,
			directory: options.archiveDirectory,
		});
		removed += outcome.rows;
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
 * Removes every event up to and including `boundarySeq`, re-anchors the chain on it, and — the first
 * time this ever succeeds — records where archived history begins.
 *
 * The mechanism behind {@link sweepAuditNow}. `lib/archive/rotate.ts`'s `archivePeriod` is this
 * function's only caller: it has already copied a prefix of the chain into a period file and calls
 * this to remove **exactly** the rows it copied, once that archive has been written and verified.
 *
 * Taking a `seq` rather than a set of them is not a convenience: a chain with a hole anywhere but its
 * oldest end cannot be vouched for by an anchor — see the module comment above. `lte` is what makes
 * that structural rather than a caller's promise.
 *
 * **The epoch claim lives inside this same transaction, not beside it.** {@link claimEpoch} writes
 * once, ever, so calling it on every removal is harmless — only the very first one that ever reaches
 * this function can actually set it, using whatever is the oldest live row *before* this removal
 * takes it away. Committing that claim with the delete and the anchor upsert closes the two failure
 * windows a separate write would leave open: claiming before this transaction could name a row that
 * a rolled-back delete never actually removes, and claiming after it could let the delete commit and
 * then lose the claim to a crash before it landed — which an install that swept before it ever
 * archived would have its oldest archive's first row read back as `link-mismatch`: a false accusation
 * of tampering against history nobody touched. `claimEpoch` takes the transaction client rather than
 * reaching for `auditDb` itself for exactly this reason; see its own doc comment.
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
		// The oldest row still live, read before it is removed. `last` above proves the table is
		// non-empty, so this always finds a row; the only question `claimEpoch` decides is whether an
		// epoch already exists to protect.
		const oldest = await tx.auditEvent.findFirst({ orderBy: { seq: "asc" }, select: { seq: true, prevHash: true } });
		if (oldest) {
			await claimEpoch(tx, oldest.seq, oldest.prevHash);
		}

		const removed = await tx.auditEvent.deleteMany({ where: { seq: { lte: boundarySeq } } });
		await tx.auditAnchor.upsert({
			where: { id: 1 },
			update: { seq: last.seq, hash: last.hash },
			create: { id: 1, seq: last.seq, hash: last.hash },
		});
		return { removed: removed.count, anchoredAt: last.seq };
	});
}
