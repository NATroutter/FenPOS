import "server-only";
import { prisma } from "@/lib/db";
import { TERMINAL_JOB_STATUSES } from "@/lib/domain/enums";

/**
 * Failing the jobs that no agent will ever report on.
 *
 * Two paths need this and neither can wait for the printer to answer: a handshake that finds the
 * agent no longer holds a job it was given, and an unpair that revokes the credential the job's only
 * possible reporter was using. Both used to write the failure inline, in the same shape, and the
 * shape was wrong in the same way in both places — so the write lives here once, and each caller
 * keeps only the part that genuinely differs: which jobs it selects, and what it does when this
 * fails.
 */

/**
 * How many job ids one statement addresses.
 *
 * A backlog has no ceiling. A job is rowed as QUEUED whether or not its agent is reachable, so an
 * outage with an integrator still submitting work grows one for as long as the outage lasts. SQLite
 * does have a ceiling on how many parameters one statement may bind, so addressing a whole backlog
 * through a single `in` list fails on precisely the agent with the most to repair — the one case
 * this repair exists for. Batching keeps every statement far inside that cap however long the
 * outage was.
 */
const BATCH_SIZE = 100;

/**
 * Fails the jobs among `ids` that are still unfinished, and reports which ones it actually changed.
 *
 * **The unfinished check happens twice, and the second one is not redundant.** A caller reaches here
 * having selected non-terminal jobs, but its selection and this update are separate statements with
 * a gap between them, and the agent is still connected and still reporting across that gap — the
 * unpair path closes the link only once this has run. A job that completes in that gap would be
 * rewritten from COMPLETED to FAILED by an update addressed on id alone, which is exactly the
 * invariant the link's own job-update handler defends: a terminal job stays terminal. Repeating the
 * predicate here is what makes the write skip that job instead of overwriting it.
 *
 * Which is also why the returned ids are read back rather than assumed. A caller announces what it
 * settled, and a receipt already announced as COMPLETED must not be contradicted by a second
 * announcement saying it failed. Only rows this call wrote — carrying this call's own `finishedAt`
 * and error code — come back.
 *
 * A batch that fails part-way leaves the batches before it written and returns nothing at all, since
 * the throw propagates. Callers decide what that means for them; both of them treat the remaining
 * jobs as still unfinished, which is what they are.
 *
 * @param ids the jobs to fail, as selected by the caller
 * @param failure the error code and message to record on each one
 * @returns the ids this call actually failed, in no particular order
 */
export async function failUnfinishedJobs(
	ids: readonly string[],
	failure: { errorCode: string; errorMessage: string },
): Promise<string[]> {
	// One moment for the whole set, so a job's `finishedAt` says when the settle ran rather than
	// which batch it happened to land in — and so the read-back below can recognise this call's own
	// writes without a second column.
	const finishedAt = new Date();
	const failed: string[] = [];

	for (let start = 0; start < ids.length; start += BATCH_SIZE) {
		const batch = ids.slice(start, start + BATCH_SIZE);

		const written = await prisma.job.updateMany({
			where: { id: { in: batch }, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
			data: {
				status: "FAILED",
				finishedAt,
				errorCode: failure.errorCode,
				errorMessage: failure.errorMessage,
				// Cleared for the same reason `failJob` clears it: a caller who retries an identical
				// body must get a fresh attempt rather than a replay of a job that never finished.
				idempotencyKey: null,
				idempotencyHash: null,
			},
		});

		if (written.count === 0) {
			continue;
		}

		const changed = await prisma.job.findMany({
			where: { id: { in: batch }, status: "FAILED", errorCode: failure.errorCode, finishedAt },
			select: { id: true },
		});

		for (const job of changed) {
			failed.push(job.id);
		}
	}

	return failed;
}
