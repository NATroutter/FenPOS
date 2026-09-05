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
import { panelAction } from "@/lib/auth/panel-action";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { CLOSE } from "@/lib/link/agent-connection";
import { getLink } from "@/lib/link/registry";
import { logger } from "@/lib/logger";

/**
 * Server actions behind the Agents tab.
 *
 * Every action goes through {@link panelAction}, which resolves the session, checks the permission
 * its registry entry names, runs the body, and records the attempt. The `logger` calls below stay
 * where they are: stdout and the audit record are two channels with two audiences.
 */

/** What every action here refreshes on success. */
const revalidate = () => revalidatePath("/agents");

/**
 * Creates a agent and issues its first pairing code.
 *
 * @param _previous prior form state, required by useActionState
 * @param formData the submitted form, carrying `name`
 * @returns the state to render
 */
export async function createAgent(_previous: ActionState, formData: FormData): Promise<ActionState> {
	const name = formData.get("name");
	return panelAction(
		"agents:create",
		async () => {
			if (typeof name !== "string") {
				throw new ApiError("missing_field", "A name is required.");
			}
			await createAgentRecord(name);
		},
		{ revalidate, target: { kind: "agent", label: typeof name === "string" ? name : null } },
	);
}

/**
 * Renames a agent.
 *
 * @param agentId the agent to rename
 * @param name the new name
 * @returns the state to render
 */
export async function renameAgent(agentId: string, name: string): Promise<ActionState> {
	return panelAction("agents:rename", () => renameAgentRecord(agentId, name), {
		revalidate,
		target: { kind: "agent", id: agentId, label: name },
	});
}

/**
 * Issues a fresh pairing code for an unpaired agent.
 *
 * @param agentId the agent to reissue for
 * @returns the state to render
 */
export async function refreshPairingCode(agentId: string): Promise<ActionState> {
	return panelAction(
		"agents:pairing-code",
		async () => {
			await regeneratePairingCode(agentId);
		},
		{ revalidate, target: { kind: "agent", id: agentId } },
	);
}

/**
 * Revokes a agent's credential and disconnects it.
 *
 * The live connection is closed here rather than in the service, because the socket registry
 * is process state and the service deliberately knows nothing about it. Clearing the token
 * alone would leave the current connection running until it happened to drop — the agent
 * would keep printing after an operator believed they had cut it off.
 *
 * Closed with the `unpaired` code rather than the ordinary one, so the agent knows to forget its
 * credential instead of reconnecting: with the ordinary code it retried forever against a token
 * this server no longer knows, and a `FENPOS_PAIR_CODE` set for the next boot was ignored because
 * an identity was still stored.
 *
 * @param agentId the agent to unpair
 * @returns the state to render
 */
export async function unpairAgent(agentId: string): Promise<ActionState> {
	return panelAction(
		"agents:unpair",
		async () => {
			await unpairAgentRecord(agentId);
			getLink(agentId)?.close("unpaired by the administrator", CLOSE.unpaired);
			logger.info("Agent unpaired", { agentId });
		},
		{ revalidate, target: { kind: "agent", id: agentId } },
	);
}

/**
 * Deletes a agent and everything configured behind it.
 *
 * Closed with the `unpaired` code, as unpairing is. From the agent's side the two say the same
 * thing — the credential this link was using no longer exists — and the code is what stops it
 * retrying for ever against a row that is gone, ignoring a fresh pairing code on every later boot
 * because an identity is still stored.
 *
 * @param agentId the agent to delete
 * @returns the state to render
 */
export async function deleteAgent(agentId: string): Promise<ActionState> {
	return panelAction(
		"agents:delete",
		async () => {
			getLink(agentId)?.close("removed by the administrator", CLOSE.unpaired);
			await deleteAgentRecord(agentId);
			logger.info("Agent deleted", { agentId });
		},
		{ revalidate, target: { kind: "agent", id: agentId } },
	);
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
	return panelAction(
		"agents:test-print",
		async () => {
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
		},
		{ revalidate, target: { kind: "agent", id: agentId } },
	);
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
