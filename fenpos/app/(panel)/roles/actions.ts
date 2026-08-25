"use server";

import { revalidatePath } from "next/cache";
import { panelAction } from "@/lib/auth/panel-action";
import {
	createRole as createRoleRecord,
	deleteRole as deleteRoleRecord,
	updateRole as updateRoleRecord,
} from "@/lib/auth/role-service";
import { prisma } from "@/lib/db";
import type { ActionState } from "@/lib/panel/action-state";

/**
 * Server actions behind the Roles tab.
 *
 * The service is imported under an alias because an action and the service function behind it share
 * a name here — the same shape `keys/actions.ts` uses. The rules are all in
 * `lib/auth/role-service.ts`, including the two escalation checks: an editor must already hold
 * everything the role carries, and everything they are putting into it.
 */

/** What both tabs refresh: a role's membership is what the Users tab renders beside each account. */
const revalidate = (): void => {
	revalidatePath("/roles");
	revalidatePath("/users");
	// The sidebar filters on what an account holds, and a role edit changes that for every member.
	revalidatePath("/", "layout");
};

/** The role form's contents, as they cross the wire. Their rules live in `role-service.ts`. */
export interface RoleFormInput {
	name: string;
	description: string;
	permissions: string[];
	memberIds: string[];
}

/**
 * Names a role in the audit row, read before the action runs so a deletion still says which.
 *
 * @param roleId the role being acted on
 * @returns the row's `target`
 */
async function roleTarget(roleId: string): Promise<{ kind: string; id: string; label: string | null }> {
	const role = await prisma.role.findUnique({ where: { id: roleId }, select: { name: true } });
	return { kind: "role", id: roleId, label: role?.name ?? null };
}

/**
 * Creates a role.
 *
 * @param input the form's contents
 * @returns the state to render
 */
export async function createRole(input: RoleFormInput): Promise<ActionState> {
	return panelAction(
		"roles:create",
		async (user) => {
			await createRoleRecord(user, input);
		},
		{
			revalidate,
			target: { kind: "role", label: input.name },
			// Named in full: "who gave that role the ability to write raw bytes" is what this row is
			// read for, and a count cannot answer it.
			detail: { permissions: input.permissions, members: input.memberIds.length },
		},
	);
}

/**
 * Replaces a role's name, description, permissions and membership.
 *
 * @param roleId the role to change
 * @param input the form's contents
 * @returns the state to render
 */
export async function updateRole(roleId: string, input: RoleFormInput): Promise<ActionState> {
	return panelAction("roles:update", (user) => updateRoleRecord(user, roleId, input), {
		revalidate,
		target: await roleTarget(roleId),
		// What it carries now. The record is a sequence, so what it carried before is the previous row.
		detail: { name: input.name, permissions: input.permissions, members: input.memberIds.length },
	});
}

/**
 * Deletes a role.
 *
 * @param roleId the role to delete
 * @returns the state to render
 */
export async function deleteRole(roleId: string): Promise<ActionState> {
	return panelAction("roles:delete", (user) => deleteRoleRecord(user, roleId), {
		revalidate,
		target: await roleTarget(roleId),
	});
}
