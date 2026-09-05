import "server-only";
import { prisma } from "@/lib/db";
import { TERMINAL_JOB_STATUSES } from "@/lib/domain/enums";
import { queueJobSettled } from "@/lib/webhooks/notify";

/**
 * Failing the jobs that no agent will ever report on, and announcing them.
 *
 * Two paths need this and neither can wait for the printer to answer: a handshake that finds the
 * agent no longer holds a job it was given, and an unpair that revokes the credential the job's only
 * possible reporter was using. Both used to write the failure inline, in the same shape, and the
 * shape was wrong in the same way in both places — so the write lives here once, and each caller
 * keeps only the part that genuinely differs: which jobs it selects, and what it does when this
 * fails.
 *
 * The write and the announcement are one step rather than two, because a job written FAILED and left
 * unannounced is unrecoverable: both callers select what is still unfinished, and a job this has
 * written is finished, so nothing ever selects it again.
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
 * Fails the jobs among `ids` that are still unfinished, announcing each one, and reports which.
 *
 * **A caller's list is already stale when it arrives.** It was selected by a separate statement, and
 * the agent is still connected and still reporting across the gap — the unpair path closes the link
 * only once this has run. So the unfinished check is made again here, against the rows as they are
 * now, and a job that settled on its own in the meantime is skipped rather than overwritten. That is
 * the invariant the link's own job-update handler defends: a terminal job stays terminal. Overwriting
 * one would also hand a webhook subscriber a second answer contradicting the first.
 *
 * **The check and the write are one transaction**, which is what makes the reported ids exact rather
 * than inferred. `updateMany` reports a count and not the rows it touched, so the ids have to come
 * from a statement of their own; inside a transaction nothing can settle between that statement and
 * the write, so what the check found is what the write wrote. Recognising the rows afterwards by
 * what was written into them cannot do this: a settle running concurrently for the same agent writes
 * the same error code, and would be indistinguishable.
 *
 * **Each batch is announced as it completes**, not at the end. A batch that throws then leaves every
 * batch before it written *and* announced, which is the only recoverable outcome: the jobs those
 * batches wrote are terminal now, so no caller will select them a second time, and an announcement
 * not made here is never made. The jobs past the failure point are untouched and still unfinished,
 * so a caller that runs again finds them. What this gives up is that a subscriber can be told about
 * an early batch while later jobs of the same set are still queued — the announcements describe the
 * work as it happens rather than the whole set at once.
 *
 * @param ids the jobs to fail, as selected by the caller
 * @param failure the error code and message to record on each one
 * @returns the ids this call failed and announced, in batch order
 */
export async function settleUnfinishedJobs(
	ids: readonly string[],
	failure: { errorCode: string; errorMessage: string },
): Promise<string[]> {
	// One moment for the whole set, so a job's `finishedAt` says when the settle ran rather than
	// which batch it happened to land in.
	const finishedAt = new Date();
	const settled: string[] = [];

	for (let start = 0; start < ids.length; start += BATCH_SIZE) {
		const batch = ids.slice(start, start + BATCH_SIZE);

		const written = await prisma.$transaction(async (tx) => {
			const unfinished = await tx.job.findMany({
				where: { id: { in: batch }, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
				select: { id: true },
			});

			if (unfinished.length === 0) {
				return [];
			}

			const writing = unfinished.map((job) => job.id);
			await tx.job.updateMany({
				// The status is stated here as well as in the read above. Inside this transaction the
				// two cannot disagree, and putting it on the statement that actually writes is what
				// keeps the constraint on the write rather than only on the read that chose its rows.
				where: { id: { in: writing }, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
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

			return writing;
		});

		// Announced outside the transaction. Announcing is itself a database write, and holding a
		// transaction open across one would put every settle in the queue behind it.
		for (const jobId of written) {
			await queueJobSettled(jobId);
			settled.push(jobId);
		}
	}

	return settled;
}
