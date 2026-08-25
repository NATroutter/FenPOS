import { GENESIS_HASH, hashEvent } from "@/lib/audit/chain";
import { prisma } from "@/lib/db";

/**
 * Walking the chain and reporting where it breaks.
 *
 * Read-only, and deliberately so: there is no repair. A chain that fails verification is evidence,
 * and a function that could "fix" it would be a function that could erase the evidence — which is
 * the exact capability the hash chain exists to deny.
 *
 * **What this detects:** an edited row (its own hash no longer matches its contents), a removed row
 * (its successor's link no longer matches the row now preceding it), a forged insert, and a swept
 * range whose anchor does not match what survived it.
 *
 * **What this cannot detect: truncation at the tail.** Deleting the newest rows leaves a shorter
 * chain that verifies perfectly, because nothing inside the table records how long it should be.
 * That is inherent to a self-contained chain rather than a gap in this implementation, and the
 * remedy is state kept where the attacker is not — shipping rows off the box, or recording the tail
 * somewhere else. Neither is in scope here, and pretending otherwise would be worse than saying so.
 */

/** How the chain failed. */
export type ChainBreak =
	/** The row's stored hash does not match a hash recomputed from its own columns. */
	| "hash-mismatch"
	/** The row's `prevHash` does not match the hash of the row before it. */
	| "link-mismatch"
	/** The oldest retained row's `prevHash` does not match what `AuditAnchor` says was swept. */
	| "anchor-mismatch";

/** The outcome of a walk. */
export type ChainVerification =
	| { ok: true; checked: number; firstSeq: number | null; lastSeq: number | null }
	| { ok: false; checked: number; brokenAt: number; reason: ChainBreak };

/**
 * Rows read per query.
 *
 * The walk is streamed rather than loaded whole: an install that has been running for a year has
 * more audit rows than anything else in the database, and `pnpm audit:verify` must not be the
 * command that runs it out of memory.
 */
const BATCH_SIZE = 500;

/**
 * Verifies the retained chain.
 *
 * @returns confirmation with the range checked, or the exact `seq` at which it breaks and how
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
	// Absent on an install that has never swept, which is not a fault: it means the chain still
	// starts where it started, at genesis.
	const anchor = await prisma.auditAnchor.findUnique({ where: { id: 1 } });

	let expectedPrevHash = anchor?.hash ?? GENESIS_HASH;
	let cursor = anchor?.seq ?? 0;
	let checked = 0;
	let firstSeq: number | null = null;
	let lastSeq: number | null = null;

	for (;;) {
		const rows = await prisma.auditEvent.findMany({
			where: { seq: { gt: cursor } },
			orderBy: { seq: "asc" },
			take: BATCH_SIZE,
		});

		if (rows.length === 0) {
			return { ok: true, checked, firstSeq, lastSeq };
		}

		for (const row of rows) {
			if (row.prevHash !== expectedPrevHash) {
				// Told apart so the report can say what happened rather than only where: an anchor
				// that disagrees with the oldest surviving row is a retention fault or a doctored
				// anchor, while a mismatch further in is a row that is no longer there.
				const reason: ChainBreak = checked === 0 && anchor !== null ? "anchor-mismatch" : "link-mismatch";
				return { ok: false, checked, brokenAt: row.seq, reason };
			}

			if (hashEvent(row, row.prevHash) !== row.hash) {
				return { ok: false, checked, brokenAt: row.seq, reason: "hash-mismatch" };
			}

			expectedPrevHash = row.hash;
			firstSeq ??= row.seq;
			lastSeq = row.seq;
			checked++;
		}

		cursor = rows[rows.length - 1].seq;
	}
}

/**
 * Renders a verification result for an operator.
 *
 * Beside the type rather than inside `scripts/audit-verify.ts` so it can be tested without
 * importing a script — importing one runs its `main()`, which would connect and disconnect the
 * shared Prisma client in the middle of a suite.
 *
 * @param result what the walk found
 * @returns the lines to print
 */
export function describeVerification(result: ChainVerification): string {
	if (result.ok && result.checked === 0) {
		return "There are no audit events to verify.";
	}
	if (result.ok) {
		return `The audit chain is intact: ${result.checked} events verified, seq ${result.firstSeq} through ${result.lastSeq}.`;
	}
	return [
		`THE AUDIT CHAIN IS BROKEN at seq ${result.brokenAt} (${result.reason}).`,
		`${result.checked} events before it verified.`,
		"",
		"This means the record was changed after it was written. Nothing here can repair it, and",
		`nothing should: seq ${result.brokenAt} is where an investigation starts.`,
	].join("\n");
}
