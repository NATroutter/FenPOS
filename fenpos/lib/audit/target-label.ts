import "server-only";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Turning an audit target's id into something a person can read.
 *
 * An action names what it acted on as `{ kind, id }`, and most of them stop there: the id is what the
 * form had. Recorded as it stands, the Target column of the audit record read `cmtl8n76c000k7vpexd8tqtef`
 * for every unpair, every delete and every test page — true, and no use to an operator scanning the
 * record for what happened to the kitchen printer. The row keeps the id, because the id is what
 * survives a rename; this adds the name beside it, looked up while the thing still exists.
 *
 * **Resolved before the action's body runs, not after.** Half the actions that name a target by id are
 * deletions, and a label looked up afterwards would find nothing to look up. The denormalised label is
 * exactly what lets a deleted device's name outlive it.
 *
 * Never throws. A label is a courtesy; an action must not fail, or go unrecorded, because the lookup
 * behind the courtesy did.
 */

/** What an action says about its target. */
export interface AuditTargetInput {
	kind: string;
	id?: string | null;
	label?: string | null;
}

/**
 * Fills in a target's label from what the database knows about it, when the caller gave none.
 *
 * A caller's own label always wins: a create action names the thing before it has an id, and a
 * rename names the new name rather than the old one the lookup would find. A kind this module does
 * not know, or an id that matches nothing, leaves the target as it was.
 *
 * @param target the target as the action named it, or undefined when it named none
 * @returns the same target, with a label where one could be found
 */
export async function describeTarget(target: AuditTargetInput | undefined): Promise<AuditTargetInput | undefined> {
	if (!target || target.label || !target.id) {
		return target;
	}

	try {
		const label = await labelFor(target.kind, target.id);
		return label === null ? target : { ...target, label };
	} catch (error) {
		logger.warn("Could not resolve an audit target's name; recording its id alone", {
			kind: target.kind,
			reason: error instanceof Error ? error.message : String(error),
		});
		return target;
	}
}

/**
 * The name a kind of thing goes by in the panel.
 *
 * Devices and jobs are qualified by their agent, the way the Devices and Jobs tabs show them, because
 * a device name is only unique within its agent. A job has no name of its own, so it borrows the
 * printer's and keeps the short id the Jobs tab uses to tell one job from the next.
 *
 * @param kind the target's kind, as the action named it
 * @param id the target's id
 * @returns the label, or null when the kind is unknown or the id matches nothing
 */
async function labelFor(kind: string, id: string): Promise<string | null> {
	switch (kind) {
		case "agent":
			return (await prisma.agent.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
		case "device": {
			const device = await prisma.device.findUnique({
				where: { id },
				select: { name: true, agent: { select: { name: true } } },
			});
			return device ? `${device.agent.name}/${device.name}` : null;
		}
		case "job": {
			const job = await prisma.job.findUnique({
				where: { id },
				select: { device: { select: { name: true, agent: { select: { name: true } } } } },
			});
			return job ? `${job.device.agent.name}/${job.device.name} · ${id.slice(-8)}` : null;
		}
		case "user":
			return (await prisma.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
		case "role":
			return (await prisma.role.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
		case "api-key":
			return (await prisma.apiKey.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
		case "asset":
			return (await prisma.asset.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
		case "variable":
			return (await prisma.variable.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
		default:
			return null;
	}
}
