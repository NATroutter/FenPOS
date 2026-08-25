import { beforeEach, describe, expect, it } from "vitest";
import { createRole, deleteRole, listRoles, updateRole } from "@/lib/auth/role-service";
import { prisma } from "@/lib/db";

/**
 * Roles: a bundle of permissions with members, editable in one place.
 *
 * "Editing a role changes every member immediately" is the whole reason roles exist here, so the
 * tests that matter are the ones about reach: what a role's editor must already hold, and what
 * happens to members when the role is emptied or removed.
 *
 * Fresh account ids throughout — `effectivePermissions` memoises per id for the life of the
 * process. See the Global Constraints.
 */
describe("role-service", () => {
	beforeEach(async () => {
		await prisma.userPermission.deleteMany({});
		await prisma.userRole.deleteMany({});
		await prisma.rolePermission.deleteMany({});
		await prisma.role.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	async function superuser(id: string) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser: true } });
		return { id, isSuperuser: true };
	}

	async function holder(id: string, permissions: string[]) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com` } });
		for (const permission of permissions) {
			await prisma.userPermission.create({ data: { userId: id, permission } });
		}
		return { id, isSuperuser: false };
	}

	const blank = { name: "Printer minder", description: "", permissions: [], memberIds: [] };

	describe("createRole", () => {
		it("creates a role carrying what it was given", async () => {
			const actor = await superuser("r1");

			const { roleId } = await createRole(actor, { ...blank, permissions: ["devices:read", "devices:pause"] });

			const [role] = await listRoles();
			expect(role.id).toBe(roleId);
			expect([...role.permissions].sort()).toEqual(["devices:pause", "devices:read"]);
		});

		it("adds the members it was given", async () => {
			const actor = await superuser("r2");
			const member = await holder("r3", []);

			const { roleId } = await createRole(actor, { ...blank, memberIds: [member.id] });

			expect(await prisma.userRole.count({ where: { roleId, userId: member.id } })).toBe(1);
		});

		it("refuses a permission the creator does not hold", async () => {
			const actor = await holder("r4", ["roles:create", "devices:read"]);

			await expect(createRole(actor, { ...blank, permissions: ["settings:write:security"] })).rejects.toThrow(
				/do not hold/i,
			);
			expect(await listRoles()).toEqual([]);
		});

		it("refuses a name another role already has", async () => {
			const actor = await superuser("r5");
			await createRole(actor, blank);

			await expect(createRole(actor, blank)).rejects.toThrow(/already/i);
		});

		it("refuses an empty name", async () => {
			const actor = await superuser("r6");

			await expect(createRole(actor, { ...blank, name: "   " })).rejects.toThrow(/name is required/i);
		});

		it("accepts a name with spaces and capitals, which is not a slug", async () => {
			const actor = await superuser("r7");

			await expect(createRole(actor, { ...blank, name: "Kitchen supervisor" })).resolves.toBeTruthy();
		});
	});

	describe("updateRole", () => {
		it("replaces the permission set wholesale, so removing one is possible", async () => {
			const actor = await superuser("r8");
			const { roleId } = await createRole(actor, { ...blank, permissions: ["devices:read", "devices:pause"] });

			await updateRole(actor, roleId, { ...blank, permissions: ["devices:read"] });

			expect((await listRoles())[0].permissions).toEqual(["devices:read"]);
		});

		it("replaces the membership wholesale", async () => {
			const actor = await superuser("r9");
			const first = await holder("r10", []);
			const second = await holder("r11", []);
			const { roleId } = await createRole(actor, { ...blank, memberIds: [first.id] });

			await updateRole(actor, roleId, { ...blank, memberIds: [second.id] });

			expect((await listRoles())[0].members.map((member) => member.id)).toEqual([second.id]);
		});

		it("refuses an editor who does not hold everything the role already carries", async () => {
			const owner = await superuser("r12");
			const { roleId } = await createRole(owner, { ...blank, permissions: ["settings:write:security"] });
			const editor = await holder("r13", ["roles:update"]);

			// Editing is how a role is emptied and refilled. Being allowed to edit it is authority over
			// everything already in it.
			await expect(updateRole(editor, roleId, { ...blank, permissions: [] })).rejects.toThrow(/do not hold/i);
		});

		it("refuses an editor adding a permission beyond their own authority", async () => {
			const owner = await superuser("r14");
			const { roleId } = await createRole(owner, { ...blank, permissions: ["devices:read"] });
			const editor = await holder("r15", ["roles:update", "devices:read"]);

			await expect(
				updateRole(editor, roleId, { ...blank, permissions: ["devices:read", "keys:create"] }),
			).rejects.toThrow(/do not hold/i);
		});

		it("changes what every member can do, immediately", async () => {
			const actor = await superuser("r16");
			const member = await holder("r17", []);
			const { roleId } = await createRole(actor, {
				...blank,
				permissions: ["devices:read"],
				memberIds: [member.id],
			});

			await updateRole(actor, roleId, { ...blank, permissions: ["jobs:cancel"], memberIds: [member.id] });

			const carried = await prisma.rolePermission.findMany({ where: { roleId }, select: { permission: true } });
			expect(carried.map((row) => row.permission)).toEqual(["jobs:cancel"]);
		});
	});

	describe("deleteRole", () => {
		it("removes the role and every membership of it", async () => {
			const actor = await superuser("r18");
			const member = await holder("r19", []);
			const { roleId } = await createRole(actor, { ...blank, memberIds: [member.id] });

			await deleteRole(actor, roleId);

			expect(await listRoles()).toEqual([]);
			expect(await prisma.userRole.count({ where: { userId: member.id } })).toBe(0);
		});

		it("leaves a member's own individual grants alone", async () => {
			const actor = await superuser("r20");
			const member = await holder("r21", ["devices:read"]);
			const { roleId } = await createRole(actor, { ...blank, memberIds: [member.id] });

			await deleteRole(actor, roleId);

			expect(await prisma.userPermission.count({ where: { userId: member.id } })).toBe(1);
		});

		it("refuses a deleter who does not hold what the role carries", async () => {
			const owner = await superuser("r22");
			const { roleId } = await createRole(owner, { ...blank, permissions: ["settings:write:security"] });
			const deleter = await holder("r23", ["roles:delete"]);

			// Deleting is how every member loses everything in the role at once, which is authority
			// over it just as much as editing is.
			await expect(deleteRole(deleter, roleId)).rejects.toThrow(/do not hold/i);
		});
	});
});
