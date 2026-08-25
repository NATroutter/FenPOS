"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { panelAction } from "@/lib/auth/panel-action";
import { cancelJob as cancelJobRequest } from "@/lib/jobs/job-service";

/**
 * Server actions behind the Jobs tab.
 *
 * The one action here goes through {@link panelAction}, which resolves the session, checks the
 * permission its registry entry names, runs the body, and records the attempt.
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
