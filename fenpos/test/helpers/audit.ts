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
