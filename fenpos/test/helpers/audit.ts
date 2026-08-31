import { auditDb } from "@/lib/db";

/**
 * The `action` of the most recently written audit row.
 *
 * Audit rows live in their own database — `auditDb.auditEvent`, not `prisma` — and are read back by
 * `seq`, the chain's own ordering, rather than by insertion order a test happened to observe: the
 * same idiom `test/app/(panel)/users/actions.test.ts` uses.
 *
 * @returns the latest row's action, or undefined when nothing has been recorded yet
 */
export async function latestAuditAction(): Promise<string | undefined> {
	const row = await auditDb.auditEvent.findFirst({ orderBy: { seq: "desc" } });
	return row?.action;
}

/**
 * The `outcome` of the most recently written audit row.
 *
 * Beside {@link latestAuditAction} for the same reason: a refusal is not fully proven by asserting
 * `state.error` is truthy, since that is also true of a thrown `FAILURE`. Reading the row's own
 * `outcome` back is what tells the two apart.
 *
 * @returns the latest row's outcome, or undefined when nothing has been recorded yet
 */
export async function latestAuditOutcome(): Promise<string | undefined> {
	const row = await auditDb.auditEvent.findFirst({ orderBy: { seq: "desc" } });
	return row?.outcome;
}
