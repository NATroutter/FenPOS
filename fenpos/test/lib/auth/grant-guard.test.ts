import { beforeEach, describe, expect, it } from "vitest";
import {
	assertMayAssignRoles,
	assertMayEditRole,
	assertMayGrant,
	parseGrantedPermissions,
	permissionsActorMayNotTouch,
} from "@/lib/auth/grant-guard";
import { prisma } from "@/lib/db";

/**
 * The rule that stops the permission model collapsing into one privilege.
 *
 * `users:grant` and `roles:update` are the two ways authority spreads. Without this rule, either of
 * them is equivalent to all of them: hold one, grant yourself the rest. Every assertion here is one
 * half of that — what a granter may pass on, and what they may not.
 *
 * Each test uses a fresh account id. `effectivePermissions` memoises per id through React's
 * `cache`, which outside a request lives as long as the process, so a reused id would answer with
 * the previous test's grants.
 */
describe("grant-guard", () => {
	beforeEach(async () => {
		await prisma.userPermission.deleteMany({});
		await prisma.userRole.deleteMany({});
		await prisma.rolePermission.deleteMany({});
		await prisma.role.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	/** An account holding exactly the listed permissions. */
	async function granter(id: string, permissions: string[], isSuperuser = false) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser } });
		for (const permission of permissions) {
			await prisma.userPermission.create({ data: { userId: id, permission } });
		}
		return { id, isSuperuser };
	}

	describe("assertMayGrant", () => {
		it("allows a permission the granter holds", async () => {
			const actor = await granter("g1", ["devices:read", "devices:pause"]);

			await expect(assertMayGrant(actor, ["devices:pause"])).resolves.toBeUndefined();
		});

		it("refuses a permission the granter does not hold, naming it", async () => {
			const actor = await granter("g2", ["devices:read"]);

			await expect(assertMayGrant(actor, ["settings:write:security"])).rejects.toThrow(/settings:write:security/);
		});

		it("refuses the whole set when one member is out of reach", async () => {
			const actor = await granter("g3", ["devices:read"]);

			// Refused rather than partially applied: a granter who asked for two things and got one is
			// left unable to tell which, and a form that silently drops half a submission is worse than
			// one that says no.
			await expect(assertMayGrant(actor, ["devices:read", "keys:create"])).rejects.toThrow();
		});

		it("lets a superuser grant something they hold no row for", async () => {
			const actor = await granter("g4", [], true);

			await expect(assertMayGrant(actor, ["settings:write:security"])).resolves.toBeUndefined();
		});

		it("refuses a permission no grant can confer, superuser included", async () => {
			const actor = await granter("g5", [], true);

			// Not an authority question. `users:set-superuser` is outside the grant system rather than
			// at the top of it, so there is nobody it can be conferred by.
			await expect(assertMayGrant(actor, ["users:set-superuser"])).rejects.toThrow(/never be granted/i);
		});

		it("counts a permission the granter holds through a role", async () => {
			await prisma.user.create({ data: { id: "g6", name: "g6", email: "g6@example.com" } });
			const role = await prisma.role.create({ data: { name: "Minder" } });
			await prisma.rolePermission.create({ data: { roleId: role.id, permission: "jobs:cancel" } });
			await prisma.userRole.create({ data: { userId: "g6", roleId: role.id } });

			await expect(assertMayGrant({ id: "g6", isSuperuser: false }, ["jobs:cancel"])).resolves.toBeUndefined();
		});

		it("allows an empty set", async () => {
			const actor = await granter("g7", []);

			await expect(assertMayGrant(actor, [])).resolves.toBeUndefined();
		});
	});

	describe("assertMayAssignRoles", () => {
		it("allows a role whose every permission the granter holds", async () => {
			const actor = await granter("g8", ["devices:read", "devices:pause"]);
			const role = await prisma.role.create({ data: { name: "Printer minder" } });
			await prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:pause" } });

			await expect(assertMayAssignRoles(actor, [role.id])).resolves.toBeUndefined();
		});

		it("refuses a role carrying one permission the granter does not hold", async () => {
			const actor = await granter("g9", ["devices:read"]);
			const role = await prisma.role.create({ data: { name: "Security" } });
			await prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:read" } });
			await prisma.rolePermission.create({ data: { roleId: role.id, permission: "settings:write:security" } });

			// Assigning a role is granting everything in it. One member out of reach puts the whole role
			// out of reach.
			await expect(assertMayAssignRoles(actor, [role.id])).rejects.toThrow(/settings:write:security/);
		});

		it("allows a role that carries nothing", async () => {
			const actor = await granter("g10", []);
			const role = await prisma.role.create({ data: { name: "Empty" } });

			await expect(assertMayAssignRoles(actor, [role.id])).resolves.toBeUndefined();
		});

		it("ignores a stored identifier this version no longer recognises", async () => {
			const actor = await granter("g11", ["devices:read"]);
			const role = await prisma.role.create({ data: { name: "Stale" } });
			await prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:teleport" } });

			// A grant nobody can name confers nothing, so it cannot be the reason a role is out of
			// reach — the same rule `parseStoredPanelPermissions` applies everywhere else.
			await expect(assertMayAssignRoles(actor, [role.id])).resolves.toBeUndefined();
		});
	});

	describe("assertMayEditRole", () => {
		it("refuses editing a role carrying a permission the granter does not hold", async () => {
			const actor = await granter("g12", ["roles:update"]);
			const role = await prisma.role.create({ data: { name: "Security" } });
			await prisma.rolePermission.create({ data: { roleId: role.id, permission: "settings:write:security" } });

			// Editing is how a role is emptied and refilled, so editing one is authority over everything
			// it already carries.
			await expect(assertMayEditRole(actor, role.id)).rejects.toThrow(/settings:write:security/);
		});

		it("allows editing a role entirely within what the granter holds", async () => {
			const actor = await granter("g13", ["devices:pause"]);
			const role = await prisma.role.create({ data: { name: "Pauser" } });
			await prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:pause" } });

			await expect(assertMayEditRole(actor, role.id)).resolves.toBeUndefined();
		});

		it("refuses a role that does not exist", async () => {
			const actor = await granter("g14", [], true);

			await expect(assertMayEditRole(actor, "no-such-role")).rejects.toThrow(/no longer exists/i);
		});
	});

	describe("parseGrantedPermissions", () => {
		it("returns the identifiers unchanged when every one is defined", () => {
			expect(parseGrantedPermissions(["devices:read", "jobs:cancel"])).toEqual(["devices:read", "jobs:cancel"]);
		});

		it("drops a duplicate rather than writing the same grant row twice", () => {
			expect(parseGrantedPermissions(["devices:read", "devices:read"])).toEqual(["devices:read"]);
		});

		it("refuses an identifier this install does not define, naming it", () => {
			// Refused rather than filtered, unlike a value read *from* the database: a form offering a
			// permission that does not exist is a bug in the form, and silently accepting the rest would
			// hide it. `parseStoredPanelPermissions` drops, because a stored row must never widen what an
			// account can do; this is the other direction.
			expect(() => parseGrantedPermissions(["devices:teleport"])).toThrow(/devices:teleport/);
		});
	});

	describe("permissionsActorMayNotTouch", () => {
		it("returns the grants outside the actor's own authority", async () => {
			const actor = await granter("g15", ["devices:read"]);

			const retained = await permissionsActorMayNotTouch(actor, ["devices:read", "settings:write:security"]);

			expect(retained).toEqual(["settings:write:security"]);
		});

		it("returns nothing for a superuser, who may touch all of it", async () => {
			const actor = await granter("g16", [], true);

			expect(await permissionsActorMayNotTouch(actor, ["settings:write:security"])).toEqual([]);
		});
	});
});
