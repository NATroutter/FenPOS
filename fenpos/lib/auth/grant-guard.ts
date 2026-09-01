import "server-only";
import { effectivePermissions } from "@/lib/auth/effective-permissions";
import { prisma } from "@/lib/db";
import {
	NEVER_GRANTABLE,
	type PanelPermission,
	panelPermissionSchema,
	parseStoredPanelPermissions,
} from "@/lib/domain/panel-permissions";
import { ApiError } from "@/lib/errors";

/**
 * A user may only grant what they themselves hold.
 *
 * `users:grant` and `roles:update` are the two paths by which authority spreads, and without this
 * rule either of them is equivalent to every permission there is: hold one, grant yourself the
 * rest, and the whole model collapses into a single privilege. Every path that can widen somebody's
 * authority goes through this module — creating an account with grants, replacing an account's
 * grants, replacing its roles, and creating, editing or deleting a role.
 *
 * **The rule lives here rather than in the five actions that need it**, because a rule with five
 * call sites written inside one of them is a rule the other four are eventually written without.
 *
 * Superusers are exempt, because they hold everything by definition and a check against their
 * grant rows would answer with rows they do not have. {@link NEVER_GRANTABLE} is not an exemption
 * anyone gets: it is checked first, for superusers too, because "can this be granted at all" is a
 * question about the permission rather than about who is asking.
 */

/** Whoever is handing something out. Only the two fields the answer depends on. */
export interface Granter {
	id: string;
	isSuperuser: boolean;
}

/**
 * Validates permission identifiers arriving from a form.
 *
 * Refused rather than filtered, which is the opposite of what {@link parseStoredPanelPermissions}
 * does to the same strings coming the other way. The asymmetry is deliberate and it is the safe
 * direction in both cases: a stored row naming something this version does not define must never be
 * treated as allowing it, so it is dropped; a *form* naming something that does not exist is a bug
 * in the form, and accepting the rest of the submission would hide it.
 *
 * Duplicates are collapsed, because the grant is a row keyed by `(subject, permission)` and asking
 * for it twice is one grant asked for clumsily, not an error.
 *
 * @param values identifiers as submitted
 * @returns the identifiers, deduplicated, in the order given
 * @throws ApiError when one of them is not a permission this install defines
 */
export function parseGrantedPermissions(values: readonly string[]): PanelPermission[] {
	const parsed: PanelPermission[] = [];
	for (const candidate of values) {
		const result = panelPermissionSchema.safeParse(candidate);
		if (!result.success) {
			throw new ApiError("invalid_type", `'${candidate}' is not a permission.`);
		}
		if (!parsed.includes(result.data)) {
			parsed.push(result.data);
		}
	}
	return parsed;
}

/**
 * Refuses a set of permissions the actor could not hand out.
 *
 * The whole set is refused when any member is out of reach, rather than the reachable part being
 * applied: a granter who asked for two things and silently got one cannot tell which, and a form
 * that drops half a submission without saying so is worse than one that says no.
 *
 * @param actor who is granting
 * @param permissions what they are trying to hand out
 * @throws ApiError when a permission is ungrantable, or is one the actor does not hold
 */
export async function assertMayGrant(actor: Granter, permissions: readonly PanelPermission[]): Promise<void> {
	for (const permission of permissions) {
		if (NEVER_GRANTABLE.includes(permission)) {
			throw new ApiError(
				"insufficient_permission",
				`'${permission}' can never be granted. Only a superuser holds it, by being one.`,
			);
		}
	}

	if (actor.isSuperuser) {
		return;
	}

	const held = await effectivePermissions(actor.id);
	const missing = permissions.filter((permission) => !held.has(permission));
	if (missing.length > 0) {
		throw new ApiError(
			"insufficient_permission",
			`You cannot grant a permission you do not hold yourself: ${missing.join(", ")}.`,
		);
	}
}

/**
 * Refuses roles the actor could not have handed out permission by permission.
 *
 * Assigning a role grants everything in it, so one member out of reach puts the whole role out of
 * reach. Unknown stored identifiers are dropped first: a grant nobody can name gives nothing, so
 * it must not be the reason a role is refused.
 *
 * @param actor who is assigning
 * @param roleIds the roles being assigned
 * @throws ApiError when any of those roles carries something the actor does not hold
 */
export async function assertMayAssignRoles(actor: Granter, roleIds: readonly string[]): Promise<void> {
	if (roleIds.length === 0 || actor.isSuperuser) {
		return;
	}

	const rows = await prisma.rolePermission.findMany({
		where: { roleId: { in: [...roleIds] } },
		select: { permission: true },
	});

	await assertMayGrant(actor, parseStoredPanelPermissions(rows.map((row) => row.permission)));
}

/**
 * Refuses editing or deleting a role that carries authority the actor does not have.
 *
 * Editing is how a role is emptied and refilled, and deleting is how every member loses everything
 * in it at once. Both are authority over what the role already carries, which is why the check is
 * against its current contents rather than against whatever is being submitted — the submitted set
 * is checked separately, by {@link assertMayGrant}.
 *
 * @param actor who is editing
 * @param roleId the role being changed
 * @throws ApiError when the role is unknown, or carries something the actor does not hold
 */
export async function assertMayEditRole(actor: Granter, roleId: string): Promise<void> {
	const role = await prisma.role.findUnique({
		where: { id: roleId },
		select: { permissions: { select: { permission: true } } },
	});
	if (!role) {
		throw new ApiError("invalid_type", "That role no longer exists.");
	}

	if (actor.isSuperuser) {
		return;
	}

	await assertMayGrant(actor, parseStoredPanelPermissions(role.permissions.map((row) => row.permission)));
}

/**
 * The grants on an account that the actor has no authority over.
 *
 * Used by the writers that replace a set wholesale, which is how the grant form reads. Without
 * this, an editor who does not hold `settings:write:security` would strip it from an account that
 * did, simply by saving the form — the checkbox is not theirs to tick, so the submission cannot
 * carry it back. These are retained untouched, and the dialog renders them checked and disabled.
 *
 * @param actor who is editing
 * @param current the account's permissions as they stand
 * @returns the subset the actor may not change, in the order given
 */
export async function permissionsActorMayNotTouch(
	actor: Granter,
	current: readonly PanelPermission[],
): Promise<PanelPermission[]> {
	if (actor.isSuperuser) {
		return [];
	}

	const held = await effectivePermissions(actor.id);
	return current.filter((permission) => !held.has(permission));
}
