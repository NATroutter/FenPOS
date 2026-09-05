import "server-only";
import { issuePairingCode } from "@/lib/agents/pairing";
import { prisma } from "@/lib/db";
import type { AgentStatus } from "@/lib/domain/enums";
import { TERMINAL_JOB_STATUSES } from "@/lib/domain/enums";
import { nameSchema } from "@/lib/domain/naming";
import { ApiError } from "@/lib/errors";
import { queueJobSettled } from "@/lib/webhooks/notify";

/**
 * Agent lifecycle as the admin panel sees it: creating, renaming, unpairing, removing.
 *
 * Pairing itself lives in pairing.ts, because the code-for-token exchange is reached by an
 * unauthenticated caller and has security properties that the rest of this file does not.
 */

/** A agent as displayed in the panel. */
export interface AgentSummary {
	id: string;
	name: string;
	status: AgentStatus;
	lastSeenAt: Date | null;
	agentVersion: string | null;
	platform: string | null;
	hostname: string | null;
	lastAddress: string | null;
	createdAt: Date;
	/** How many printers are configured behind this agent. */
	deviceCount: number;
	/**
	 * Whether the agent holds a credential.
	 *
	 * This, not the presence of a pairing code, is what says whether an agent can connect: a code
	 * lapses on its own after `pairing.codeMinutes`, and an unpaired agent whose code has lapsed is
	 * still unpaired. Deriving "awaiting pairing" from the code alone showed exactly that agent as
	 * merely offline, with no code on screen and no way to issue one.
	 */
	paired: boolean;
	/** The outstanding pairing code, present only while the agent is unpaired and one is live. */
	pairing: { code: string; expiresAt: Date } | null;
}

/**
 * Lists every agent for the panel.
 *
 * An expired pairing code is reported as absent rather than shown greyed out: a code that no
 * longer works should not be on screen to be typed.
 *
 * @param now current time; injectable for tests
 * @returns agents ordered by creation, oldest first
 */
export async function listAgents(now: Date = new Date()): Promise<AgentSummary[]> {
	const agents = await prisma.agent.findMany({
		orderBy: { createdAt: "asc" },
		include: {
			_count: { select: { devices: true } },
			pairingCodes: {
				where: { consumedAt: null, expiresAt: { gt: now } },
				orderBy: { createdAt: "desc" },
				take: 1,
				select: { code: true, expiresAt: true },
			},
		},
	});

	return agents.map((agent) => ({
		id: agent.id,
		name: agent.name,
		status: agent.status as AgentStatus,
		lastSeenAt: agent.lastSeenAt,
		agentVersion: agent.agentVersion,
		platform: agent.platform,
		hostname: agent.hostname,
		lastAddress: agent.lastAddress,
		createdAt: agent.createdAt,
		deviceCount: agent._count.devices,
		paired: agent.tokenHash !== null,
		pairing: agent.pairingCodes[0] ?? null,
	}));
}

/**
 * Creates a agent and issues its first pairing code.
 *
 * The agent exists immediately in `PENDING`, before anything has connected. That is what lets
 * an operator prepare a site in advance and hand the code to whoever installs the hardware.
 *
 * @param rawName the name as entered
 * @returns the new agent's id and its pairing code
 * @throws ApiError when the name is invalid or already taken
 */
export async function createAgent(rawName: string): Promise<{ id: string; code: string; expiresAt: Date }> {
	const name = parseName(rawName);

	if (await prisma.agent.findUnique({ where: { name }, select: { id: true } })) {
		throw new ApiError("name_taken", `A agent named "${name}" already exists.`, { field: "name" });
	}

	const agent = await prisma.agent.create({ data: { name }, select: { id: true } });
	const { code, expiresAt } = await issuePairingCode(agent.id);

	return { id: agent.id, code, expiresAt };
}

/**
 * Issues a fresh pairing code, invalidating any outstanding one.
 *
 * Refused for a agent that is already paired. Re-pairing an active agent is a distinct
 * decision with a distinct consequence — the running agent loses its credential — so it is
 * reached through {@link unpairAgent} rather than by quietly issuing a second code.
 *
 * @param agentId the agent to reissue for
 * @returns the new code and its expiry
 * @throws ApiError when the agent is unknown or already paired
 */
export async function regeneratePairingCode(agentId: string): Promise<{ code: string; expiresAt: Date }> {
	const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { tokenHash: true } });
	if (!agent) {
		throw new ApiError("unknown_agent", "No such agent.");
	}
	if (agent.tokenHash !== null) {
		throw new ApiError("agent_already_paired", "This agent is already paired. Unpair it first.");
	}

	return issuePairingCode(agentId);
}

/**
 * Renames a agent.
 *
 * The name is part of the public API path, so a rename changes the URL that clients use.
 * That is the operator's call to make, but it is not a cosmetic change.
 *
 * @param agentId the agent to rename
 * @param rawName the new name
 * @throws ApiError when the name is invalid, taken, or the agent is unknown
 */
export async function renameAgent(agentId: string, rawName: string): Promise<void> {
	const name = parseName(rawName);

	const clash = await prisma.agent.findUnique({ where: { name }, select: { id: true } });
	if (clash && clash.id !== agentId) {
		throw new ApiError("name_taken", `A agent named "${name}" already exists.`, { field: "name" });
	}

	const updated = await prisma.agent.updateMany({ where: { id: agentId }, data: { name } });
	if (updated.count === 0) {
		throw new ApiError("unknown_agent", "No such agent.");
	}
}

/**
 * Revokes a agent's credential and returns it to `PENDING`.
 *
 * Clearing the token is what actually revokes access: the running agent's next connection is
 * refused, and it cannot reconnect until it is paired again. Devices are kept, so re-pairing
 * a replaced machine restores the site without reconfiguring every printer.
 *
 * A fresh pairing code is issued in the same step, for the same reason {@link createAgent}
 * issues one: an unpaired agent's next state is "pair it", and the operator who just unpaired it
 * is the one standing there needing the code. Without this the card showed the agent as merely
 * offline — the same button, the same details, nothing to type on the replacement machine — and
 * the only way to a code was deleting the agent and creating it again, printers and all.
 *
 * Every non-terminal job this agent accepted is also failed and announced. The agent will not
 * reconnect to report how those jobs end — its credential is revoked, and only this printer's
 * agent can answer for it — so left unresolved they would read as queued forever.
 *
 * Closing the live connection is the caller's responsibility — the registry that owns
 * sockets is deliberately not reachable from here, so that this module stays testable
 * without one.
 *
 * @param agentId the agent to unpair
 * @returns the new pairing code and its expiry
 * @throws ApiError when the agent is unknown
 */
export async function unpairAgent(agentId: string): Promise<{ code: string; expiresAt: Date }> {
	const updated = await prisma.agent.updateMany({
		where: { id: agentId },
		data: { status: "PENDING", tokenHash: null, lastSeenAt: null },
	});

	if (updated.count === 0) {
		throw new ApiError("unknown_agent", "No such agent.");
	}

	// The agent will never report on these. Its credential is gone, so it cannot reconnect to
	// tell anyone how they ended, and nothing else on this side can answer for a printer. Left
	// alone they would read as queued for ever. Selected before the update because `updateMany`
	// does not hand back the rows it touched, and each one still needs its own announcement below.
	const stranded = await prisma.job.findMany({
		where: { agentId, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
		select: { id: true },
	});

	if (stranded.length > 0) {
		await prisma.job.updateMany({
			where: { id: { in: stranded.map((job) => job.id) } },
			data: {
				status: "FAILED",
				finishedAt: new Date(),
				errorCode: "agent_unpaired",
				errorMessage: "The agent was unpaired before this job finished.",
				idempotencyKey: null,
				idempotencyHash: null,
			},
		});

		// A caller subscribed to a webhook is waiting for precisely this answer, and an unpair
		// must tell it the same way a reconnect that finds a job gone does.
		for (const job of stranded) {
			await queueJobSettled(job.id);
		}
	}

	// Replaces any outstanding code: one from the previous pairing attempt must not carry over,
	// and issuePairingCode already invalidates whatever is there before writing the new one.
	return issuePairingCode(agentId);
}

/**
 * Deletes a agent and everything configured behind it.
 *
 * Devices, jobs and log entries cascade. This is destructive and irreversible, which is why
 * the panel confirms it and why the count of what will go is shown first.
 *
 * @param agentId the agent to delete
 * @throws ApiError when the agent is unknown
 */
export async function deleteAgent(agentId: string): Promise<void> {
	const deleted = await prisma.agent.deleteMany({ where: { id: agentId } });
	if (deleted.count === 0) {
		throw new ApiError("unknown_agent", "No such agent.");
	}
}

/**
 * Validates a name, raising the API error shape on failure.
 *
 * @param rawName the name as entered
 * @returns the validated name
 * @throws ApiError when the name does not satisfy the naming rules
 */
function parseName(rawName: string): string {
	// Trailing separators are kept while typing so word boundaries survive; they are trimmed
	// here, at the point the name is actually committed.
	const parsed = nameSchema.safeParse(rawName.trim().replace(/-+$/, ""));
	if (!parsed.success) {
		throw new ApiError("invalid_type", parsed.error.issues[0].message, { field: "name" });
	}
	return parsed.data;
}
