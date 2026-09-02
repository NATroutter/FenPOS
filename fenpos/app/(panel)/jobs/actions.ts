"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { type JobsSearchParams, parseJobsSearchParams } from "@/app/(panel)/jobs/search-params";
import { panelAction, panelQuery } from "@/lib/auth/panel-action";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import { cancelJob as cancelJobRequest, type JobSummary, listJobs } from "@/lib/jobs/job-service";
import { integerSetting } from "@/lib/settings/settings-service";
import { parseOffset } from "@/lib/table/multi-filter";

/**
 * Server actions behind the Jobs tab.
 *
 * `cancelJob` goes through {@link panelAction}, which resolves the session, checks the permission its
 * registry entry names, runs the body, and records the attempt. `listMoreJobs` goes through
 * {@link panelQuery} instead: it shapes its own result — a batch of jobs rather than an
 * {@link ActionState} — and it is registered `query` rather than `command`, because it is what the
 * Jobs tab's infinite scroll calls on every approach to the bottom of the list, and a row per scroll
 * would bury the one action on this tab actually worth recording.
 */

/**
 * Asks the agent to withdraw a job that has not started.
 *
 * @param jobId the job to cancel
 * @returns the state to render
 */
export async function cancelJob(jobId: string): Promise<ActionState> {
	return panelAction("jobs:cancel", () => cancelJobRequest(jobId), {
		revalidate: () => revalidatePath("/jobs"),
		target: { kind: "job", id: jobId },
	});
}

/** What {@link listMoreJobs} takes: the tab's current filter and sort, plus how many rows are already loaded. */
export interface JobsBatchRequest extends JobsSearchParams {
	offset: unknown;
}

/** What {@link listMoreJobs} hands back. */
export interface JobsBatch {
	jobs: JobSummary[];
	more: boolean;
	error: string | null;
}

/**
 * Loads the next batch of jobs for the Jobs tab's infinite scroll.
 *
 * **Re-checks `jobs:read` itself, rather than trusting that the page already did.** A server action is
 * a public endpoint reachable by anyone who can construct the POST it compiles to, not only by a
 * browser that first rendered the page behind `requirePagePermission` — the gate here is what actually
 * stops that request, not a formality restating one already run.
 *
 * **Reuses `listJobs`, the same function the page's own first batch comes from**, narrowed by
 * {@link parseJobsSearchParams} — the same parser the page uses on its own `searchParams` — so a batch
 * the sentinel appends is narrowed exactly as the page's own first batch was. See that module's doc for
 * why the two have to agree.
 *
 * @param request the tab's filter and sort, and how many jobs are already on screen
 * @returns the next batch, or an empty one with a reason when it could not be read
 */
export async function listMoreJobs(request: JobsBatchRequest): Promise<JobsBatch> {
	return panelQuery<JobsBatch>(
		"jobs:list-more",
		async () => {
			const filter = parseJobsSearchParams(request);
			const pageSize = await integerSetting("panel.jobPageSize");
			const page = await listJobs({
				agentId: filter.agentIds,
				deviceId: filter.deviceIds,
				status: filter.statuses,
				sort: filter.sort,
				desc: filter.desc,
				skip: parseOffset(request.offset),
				take: pageSize,
			});
			return { jobs: page.jobs, more: page.more, error: null };
		},
		{
			refused: () => ({ jobs: [], more: false, error: REFUSAL_MESSAGE }),
			failed: () => ({ jobs: [], more: false, error: "Something went wrong. Check the server log." }),
		},
	);
}
