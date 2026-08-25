import "server-only";
import { assertMayEditRole, assertMayGrant, type Granter, parseGrantedPermissions } from "@/lib/auth/grant-guard";
import { prisma } from "@/lib/db";
import { isUniqueViolationOn } from "@/lib/db-errors";
import { type PanelPermission, parseStoredPanelPermissions } from "@/lib/domain/panel-permissions";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Roles: a named bundle of permissions, with members.
 *
 * Roles are additive to individual grants rather than a replacement for them, and that is what makes
 * them worth having: **editing a role changes every member immediately**, so revoking a capability
 * across a whole shift is one edit rather than one per person. There is no deny row, so an account's
 * authority is always a union and never a subtraction.
 *
 * Every function that can widen what a role carries goes through `grant-guard.ts` twice — once
 * against what the role already holds, because editing is how a role is emptied and refilled, and
 * once against what is being submitted. Deleting checks the first of those and not the second: it
 * takes everything away from every member at once, which is authority over the role's contents even
 * though it confers nothing.
 */

/** A role as the Roles page displays it. */
export interface RoleSummary {
	id: string;
	name: string;
	description: string | null;
	permissions: PanelPermission[];
	/** The accounts in it, by id and display name. */
	members: { id: string; name: string }[];
	createdAt: Date;
}

/** Everything the role form collects. Both lists are the complete new state, not a delta. */
export interface RoleInput {
	name: string;
	description: string;
	permissions: string[];
	memberIds: string[];
}

/** Longest role name accepted. Display text in a fixed layout, like an API key's name. */
const MAX_ROLE_NAME_LENGTH = 64;

/** Longest description accepted. One line explaining what the role is for. */
const MAX_ROLE_DESCRIPTION_LENGTH = 200;

/**
 * Lists every role for the panel.
 *
 * @returns roles ordered by name, so the list does not reorder itself as roles are edited
 */
export async function listRoles(): Promise<RoleSummary[]> {
	const rows = await prisma.role.findMany({
		orderBy: { name: "asc" },
		include: {
			permissions: { select: { permission: true } },
			members: { select: { user: { select: { id: true, name: true } } } },
		},
	});

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		description: row.description,
		permissions: parseStoredPanelPermissions(row.permissions.map((entry) => entry.permission)),
		members: row.members.map((entry) => entry.user),
		createdAt: row.createdAt,
	}));
}

/**
 * Creates a role.
 *
 * @param actor the account creating it, whose own authority bounds what it may carry
 * @param input the form's contents
 * @returns the new role's id
 * @throws ApiError when a field is unacceptable, the name is taken, or a permission exceeds the
 *   actor's own authority
 */
export async function createRole(actor: Granter, input: RoleInput): Promise<{ roleId: string }> {
	const name = parseRoleName(input.name);
	const description = parseRoleDescription(input.description);
	const permissions = parseGrantedPermissions(input.permissions);
	const memberIds = [...new Set(input.memberIds)];

	await assertMayGrant(actor, permissions);

	const roleId = await prisma
		.$transaction(async (tx) => {
			const role = await tx.role.create({ data: { name, description }, select: { id: true } });

			if (permissions.length > 0) {
				await tx.rolePermission.createMany({
					data: permissions.map((permission) => ({ roleId: role.id, permission })),
				});
			}
			if (memberIds.length > 0) {
				await tx.userRole.createMany({ data: memberIds.map((userId) => ({ userId, roleId: role.id })) });
			}

			return role.id;
		})
		.catch((error: unknown) => {
			if (isUniqueViolationOn(error, ["name"])) {
				throw new ApiError("name_taken", "A role with that name already exists.");
			}
			throw error;
		});

	logger.info("Role created", { roleId, name, permissions: permissions.length, members: memberIds.length });
	return { roleId };
}

/**
 * Replaces a role's name, description, permissions and membership.
 *
 * Everything is replaced wholesale rather than merged, so the form is the whole truth about the
 * role. A merge would make removing a permission impossible from the same screen that added it —
 * the reasoning `updateApiKeyGrants` already states for a key's grants.
 *
 * @param actor the account editing it
 * @param roleId the role to change
 * @param input the form's contents
 * @throws ApiError when the role is unknown, a field is unacceptable, the name is taken, or either
 *   the role's current contents or its new ones exceed the actor's own authority
 */
export async function updateRole(actor: Granter, roleId: string, input: RoleInput): Promise<void> {
	const name = parseRoleName(input.name);
	const description = parseRoleDescription(input.description);
	const permissions = parseGrantedPermissions(input.permissions);
	const memberIds = [...new Set(input.memberIds)];

	// Both, and in this order. The first says the actor may touch this role at all; the second says
	// what they are trying to put in it is theirs to give.
	await assertMayEditRole(actor, roleId);
	await assertMayGrant(actor, permissions);

	await prisma
		.$transaction(async (tx) => {
			await tx.role.update({ where: { id: roleId }, data: { name, description } });
			await tx.rolePermission.deleteMany({ where: { roleId } });
			await tx.userRole.deleteMany({ where: { roleId } });

			if (permissions.length > 0) {
				await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permission })) });
			}
			if (memberIds.length > 0) {
				await tx.userRole.createMany({ data: memberIds.map((userId) => ({ userId, roleId })) });
			}
		})
		.catch((error: unknown) => {
			if (isUniqueViolationOn(error, ["name"])) {
				throw new ApiError("name_taken", "A role with that name already exists.");
			}
			throw error;
		});

	logger.info("Role updated", { roleId, permissions: permissions.length, members: memberIds.length });
}

/**
 * Deletes a role.
 *
 * Its permission rows and its memberships go with it — both cascade. Members keep every permission
 * granted to them individually, because those are a different statement about them and were never
 * this role's to take away.
 *
 * @param actor the account deleting it
 * @param roleId the role to delete
 * @throws ApiError when the role is unknown, or carries something the actor does not hold
 */
export async function deleteRole(actor: Granter, roleId: string): Promise<void> {
	await assertMayEditRole(actor, roleId);

	await prisma.role.delete({ where: { id: roleId } });
	logger.info("Role deleted", { roleId });
}

/**
 * Validates a role name.
 *
 * Display text rather than a slug: a role is never a path segment and never reaches an agent, so
 * `nameSchema`'s lowercase-and-dashes rule — which exists because agent and device names are
 * interpolated into URLs — would only stop an operator writing "Kitchen supervisor".
 *
 * @param raw the name as typed
 * @returns the trimmed name
 * @throws ApiError when it is empty or too long
 */
function parseRoleName(raw: string): string {
	const name = (raw ?? "").trim();
	if (name === "") {
		throw new ApiError("missing_field", "A name is required.");
	}
	if (name.length > MAX_ROLE_NAME_LENGTH) {
		throw new ApiError("invalid_type", `Name must be at most ${MAX_ROLE_NAME_LENGTH} characters.`);
	}
	return name;
}

/**
 * Validates a role description, which may be empty.
 *
 * @param raw the description as typed
 * @returns the trimmed description, or null when nothing was written
 * @throws ApiError when it is too long
 */
function parseRoleDescription(raw: string): string | null {
	const description = (raw ?? "").trim();
	if (description === "") {
		return null;
	}
	if (description.length > MAX_ROLE_DESCRIPTION_LENGTH) {
		throw new ApiError("invalid_type", `Description must be at most ${MAX_ROLE_DESCRIPTION_LENGTH} characters.`);
	}
	return description;
}
