import "server-only";
import type { PrismaClient } from "@/generated/prisma-audit/client";
import { auditDb } from "@/lib/db";

/**
 * Where archived history begins, and the only code that moves it.
 *
 * `AuditAnchor` says what was last swept; this says what the oldest archive should start with. The
 * two are needed together: without this, an archive walk cannot tell history that was swept before
 * archiving began — which is every install upgraded from the storage foundation — from an archive
 * somebody deleted. The first reads as an unverifiable prefix and the second as tampering, and
 * guessing between them is how a verifier ends up accusing an install nobody touched.
 *
 * **Nothing on a timer advances it.** {@link claimEpoch} writes once, when archiving first covers a
 * sweep, and refuses afterwards; {@link advanceEpoch} runs only from the panel action that deletes an
 * archive, which is a person's decision and writes its own audit row. An epoch that moved on a
 * schedule would be one an attacker could wait for instead of defeat.
 */

/** Where archived history begins. */
export interface AuditEpochRecord {
	/** `seq` of the oldest event archiving is complete from. */
	seq: number;
	/** That event's `prevHash`. */
	prevHash: string;
}

/**
 * Reads the epoch.
 *
 * @returns the epoch, or null on an install that has never archived
 */
export async function readEpoch(): Promise<AuditEpochRecord | null> {
	const row = await auditDb.auditEpoch.findUnique({ where: { id: 1 }, select: { seq: true, prevHash: true } });
	return row ?? null;
}

/**
 * Records where archived history begins, if nothing has yet.
 *
 * Deliberately not an upsert. The first archiving sweep is the only event that can answer this
 * question — every later one archives history that already had an epoch behind it, and letting one
 * overwrite the answer would turn the epoch into a follower of rotation rather than a record of
 * where rotation started.
 *
 * **Takes a client rather than reaching for `auditDb` itself, because the one caller that matters —
 * `removeAuditThrough` in `lib/audit/retention.ts` — must call this from inside its own transaction,
 * alongside the delete and the anchor upsert it protects.** Reaching for the module-level `auditDb`
 * here would issue this write *outside* that transaction against the same SQLite file: it would lose
 * the atomicity the transaction exists to buy, and could deadlock against the open write transaction.
 * See `removeAuditThrough`'s doc comment for why the three writes have to land together or not at all.
 *
 * Implemented as a guarded create rather than `createMany` with `skipDuplicates` — SQLite has no such
 * option in either generated client. The read-then-create is not what makes this safe against two
 * concurrent writers; running inside `removeAuditThrough`'s transaction is what does, since SQLite
 * serialises writers against one file and this is one of them. The `try`/`catch` below exists so
 * "writes once, ever" holds as a structural property of this function rather than as something that
 * happens to be true only because of how it is currently called: if a unique-constraint violation
 * (`P2002`) reaches here anyway, it is swallowed as a no-op rather than allowed to overwrite the
 * existing row.
 *
 * @param client the transaction this write must commit or roll back with
 * @param seq the oldest event being archived
 * @param prevHash that event's `prevHash`
 */
export async function claimEpoch(
	client: Pick<PrismaClient, "auditEpoch">,
	seq: number,
	prevHash: string,
): Promise<void> {
	const existing = await client.auditEpoch.findUnique({ where: { id: 1 }, select: { id: true } });
	if (existing) {
		return;
	}

	try {
		await client.auditEpoch.create({ data: { id: 1, seq, prevHash } });
	} catch (error) {
		if (!isPrismaCode(error, "P2002")) {
			throw error;
		}
	}
}

/**
 * Whether a caught value is Prisma reporting a unique-constraint violation.
 *
 * Matched on the code rather than the message so a wording change upstream cannot silently turn
 * this into a swallowed unrelated failure. Duck-typed rather than an `instanceof`, because the
 * error class lives in the generated client and importing it here to test one string would be a
 * heavier coupling than the check is worth. Same shape as `isPrismaCode` in
 * `app/(panel)/settings/actions.ts` and `lib/assets/asset-service.ts`.
 *
 * @param error the caught value
 * @param code the Prisma error code to match, e.g. `P2002`
 * @returns true when the error carries that code
 */
function isPrismaCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * Moves the epoch forward after an archive is deliberately deleted.
 *
 * The one path that may move it, and it is reached only from the panel action gated by
 * `audit:archive-delete`. Advancing it is what keeps verification honest about a shortened record:
 * the history is gone, and the epoch says so rather than leaving the walk to report a missing file.
 *
 * @param seq the oldest event still archived
 * @param prevHash that event's `prevHash`
 */
export async function advanceEpoch(seq: number, prevHash: string): Promise<void> {
	await auditDb.auditEpoch.upsert({
		where: { id: 1 },
		update: { seq, prevHash },
		create: { id: 1, seq, prevHash },
	});
}
