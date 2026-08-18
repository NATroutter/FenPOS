"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { getCurrentSession } from "@/lib/auth/session-cookie";
import { ApiError } from "@/lib/errors";
import { cancelJob as cancelJobRequest } from "@/lib/jobs/job-service";
import { logger } from "@/lib/logger";

/**
 * Server actions behind the Jobs tab.
 *
 * The session is re-checked here rather than trusted from the layout: an action is a POST
 * endpoint in its own right, callable by anyone who knows its id.
 */

/**
 * Asks the agent to withdraw a job that has not started.
 *
 * @param jobId the job to cancel
 * @returns the state to render
 */
export async function cancelJob(jobId: string): Promise<ActionState> {
	try {
		if (!(await getCurrentSession())) {
			throw new ApiError("missing_key", "Not signed in.");
		}
		await cancelJobRequest(jobId);
		revalidatePath("/jobs");
		return { error: null };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message };
		}
		logger.error("Job action failed: cancel", error);
		return { error: "Something went wrong. Check the server log." };
	}
}
