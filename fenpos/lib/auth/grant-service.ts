import "server-only";
import {
	assertMayAssignRoles,
	assertMayGrant,
	type Granter,
	parseGrantedPermissions,
	permissionsActorMayNotTouch,
} from "@/lib/auth/grant-guard";
import { prisma } from "@/lib/db";
import { parseStoredPanelPermissions } from "@/lib/domain/panel-permissions";
import { logger } from "@/lib/logger";

/**
 * Replacing what one account holds.
 *
 * Both functions here take the complete new state rather than a delta, because that is what the
 * form sends and a merge would make removing a grant impossible from the screen that added it.
 *
 * **What is replaced is only the part the editor has authority over.** The rest is retained
 * untouched, and that is not a convenience — it is what stops the wholesale replace becoming a
 * privilege *removal* vector. An editor who does not hold `settings:write:security` is not offered a
 * checkbox for it, so their submission cannot carry it back; without the split below, saving the
 * form would strip it from an account that had it. A permission the editor does not hold and
 * submitted anyway is refused outright rather than dropped, because an escalation attempt that looks
 * like it worked is worse than one that is turned down.
 */

/**
 * Replaces an account's individual permission grants.
 *
 * @param actor the account making the change
 * @param userId the account being changed
 * @param permissions the complete new set, as the form sent it
 * @throws ApiError when an identifier is unknown, ungrantable, or beyond the actor's own authority
 */
export async function setAccountPermissions(actor: Granter, userId: string, permissions: string[]): Promise<void> {
	const chosen = parseGrantedPermissions(permissions);
	await assertMayGrant(actor, chosen);

	const existing = await prisma.userPermission.findMany({ where: { userId }, select: { permission: true } });
	const retained = await permissionsActorMayNotTouch(
		actor,
		parseStoredPanelPermissions(existing.map((row) => row.permission)),
	);

	const final = [...new Set([...retained, ...chosen])];

	await prisma.$transaction([
		prisma.userPermission.deleteMany({ where: { userId } }),
		prisma.userPermission.createMany({ data: final.map((permission) => ({ userId, permission })) }),
	]);

	logger.info("Account permissions replaced", { userId, granted: final.length, retained: retained.length });
}

/**
 * Replaces an account's roles.
 *
 * The same split as {@link setAccountPermissions}, applied a level up: a role the actor could not
 * have assigned is a role they may not take away either, because taking it away removes everything
 * in it from this account and none of that was theirs to remove.
 *
 * @param actor the account making the change
 * @param userId the account being changed
 * @param roleIds the complete new set, as the form sent it
 * @throws ApiError when a role carries something beyond the actor's own authority
 */
export async function setAccountRoles(actor: Granter, userId: string, roleIds: string[]): Promise<void> {
	const chosen = [...new Set(roleIds)];
	await assertMayAssignRoles(actor, chosen);

	const existing = await prisma.userRole.findMany({
		where: { userId },
		select: { roleId: true, role: { select: { permissions: { select: { permission: true } } } } },
	});

	const retained: string[] = [];
	for (const entry of existing) {
		const carried = parseStoredPanelPermissions(entry.role.permissions.map((row) => row.permission));
		// Sequential rather than concurrent: `permissionsActorMayNotTouch` reads a per-request memo
		// after the first call, so there is nothing to overlap.
		if ((await permissionsActorMayNotTouch(actor, carried)).length > 0) {
			retained.push(entry.roleId);
		}
	}

	const final = [...new Set([...retained, ...chosen])];

	await prisma.$transaction([
		prisma.userRole.deleteMany({ where: { userId } }),
		prisma.userRole.createMany({ data: final.map((roleId) => ({ userId, roleId })) }),
	]);

	logger.info("Account roles replaced", { userId, roles: final.length, retained: retained.length });
}
