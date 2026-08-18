"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import {
	createAgent as createAgentRecord,
	deleteAgent as deleteAgentRecord,
	regeneratePairingCode,
	renameAgent as renameAgentRecord,
	unpairAgent as unpairAgentRecord,
} from "@/lib/agents/agent-service";
import { getCurrentSession } from "@/lib/auth/session-cookie";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { getLink } from "@/lib/link/registry";
import { logger } from "@/lib/logger";

/**
 * Server actions behind the Agents tab.
 *
 * Every action re-checks the session. The panel layout already guards the page, but an
 * action is a POST endpoint in its own right: anything that trusted the layout would be
 * callable directly by anyone who knew the action id. Authorisation belongs at the action,
 * not at the page that happens to render its button.
 */

/**
 * Rejects the call unless the request carries a valid administrator session.
 *
 * @throws ApiError when the caller is not signed in
 */
async function requireSession(): Promise<void> {
	if (!(await getCurrentSession())) {
		throw new ApiError("missing_key", "Not signed in.");
	}
}

/**
 * Runs an action, converting a failure into a message the form can render.
 *
 * An `ApiError` carries a message written to be read, so it is passed through. Anything else
 * is unexpected: it is logged in full and reported generically, because an internal message
 * in the panel is at best noise and at worst a disclosure.
 *
 * @param label short description used in the log line
 * @param work the action body
 * @returns the state to render
 */
async function run(label: string, work: () => Promise<void>): Promise<ActionState> {
	try {
		await requireSession();
		await work();
		revalidatePath("/agents");
		return { error: null };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message };
		}
		logger.error(`Agent action failed: ${label}`, error);
		return { error: "Something went wrong. Check the server log." };
	}
}

/**
 * Creates a agent and issues its first pairing code.
 *
 * @param _previous prior form state, required by useActionState
 * @param formData the submitted form, carrying `name`
 * @returns the state to render
 */
export async function createAgent(_previous: ActionState, formData: FormData): Promise<ActionState> {
	const name = formData.get("name");
	return run("create", async () => {
		if (typeof name !== "string") {
			throw new ApiError("missing_field", "A name is required.");
		}
		await createAgentRecord(name);
	});
}

/**
 * Renames a agent.
 *
 * @param agentId the agent to rename
 * @param name the new name
 * @returns the state to render
 */
export async function renameAgent(agentId: string, name: string): Promise<ActionState> {
	return run("rename", () => renameAgentRecord(agentId, name));
}

/**
 * Issues a fresh pairing code for an unpaired agent.
 *
 * @param agentId the agent to reissue for
 * @returns the state to render
 */
export async function refreshPairingCode(agentId: string): Promise<ActionState> {
	return run("regenerate code", async () => {
		await regeneratePairingCode(agentId);
	});
}

/**
 * Revokes a agent's credential and disconnects it.
 *
 * The live connection is closed here rather than in the service, because the socket registry
 * is process state and the service deliberately knows nothing about it. Clearing the token
 * alone would leave the current connection running until it happened to drop — the agent
 * would keep printing after an operator believed they had cut it off.
 *
 * @param agentId the agent to unpair
 * @returns the state to render
 */
export async function unpairAgent(agentId: string): Promise<ActionState> {
	return run("unpair", async () => {
		await unpairAgentRecord(agentId);
		getLink(agentId)?.close("unpaired by the administrator");
		logger.info("Agent unpaired", { agentId });
	});
}

/**
 * Deletes a agent and everything configured behind it.
 *
 * @param agentId the agent to delete
 * @returns the state to render
 */
export async function deleteAgent(agentId: string): Promise<ActionState> {
	return run("delete", async () => {
		getLink(agentId)?.close("removed by the administrator");
		await deleteAgentRecord(agentId);
		logger.info("Agent deleted", { agentId });
	});
}

/**
 * Sends a job through the server's own compile-and-dispatch path.
 *
 * Distinct from the test page on the Devices tab, and worth keeping alongside it because they
 * prove different halves. The device test page is composed by the agent, so it says whether the
 * printer is set up correctly. This one is composed here, wrapped here, recorded as a job here
 * and pushed over the link — so it says whether the *server's* path to paper works, which is
 * what every API print will use.
 *
 * @param agentId the agent to print on
 * @returns the state to render
 */
export async function sendTestPrint(agentId: string): Promise<ActionState> {
	return run("test print", async () => {
		const device = await prisma.device.findFirst({
			where: { agentId },
			orderBy: { name: "asc" },
			select: { id: true },
		});

		if (!device) {
			throw new ApiError("unknown_device", "This agent has no printer configured yet. Add one before printing.");
		}

		const job = await submitJob(device.id, { data: testJob() });
		logger.info("Test job submitted", { agentId, jobId: job.id, deviceName: job.deviceName });
	});
}

/**
 * The markup of the test job.
 *
 * Written as markup rather than plain strings so it exercises the pipeline it is meant to prove.
 * A page using none of the grammar would still print if the parser were broken, which would make
 * it a worse check than no check at all.
 *
 * @returns the elements to submit
 */
function testJob(): string[] {
	return [
		"<align=center><bold>FenPOS test job</bold></align>",
		"<hr>",
		`Submitted: ${new Date().toISOString()}`,
		"",
		"Compiled by the server, wrapped to this printer's width, and sent over the link.",
		"<feed=3>",
		"<cut>",
	];
}
