import { beforeEach, describe, expect, it } from "vitest";
import { effectivePermissions, userHolds } from "@/lib/auth/effective-permissions";
import { prisma } from "@/lib/db";

/**
 * What an account may actually do.
 *
 * The union of its own grants and its roles', with anything unrecognised dropped. Every assertion
 * here is one half of a rule somebody could get wrong in a way no page would reveal: a role's
 * permissions silently not counting, a stale identifier silently counting, or a superuser's bypass
 * quietly depending on rows they do not have.
 */
describe("effectivePermissions", () => {
	beforeEach(async () => {
		await prisma.userPermission.deleteMany({});
		await prisma.userRole.deleteMany({});
		await prisma.rolePermission.deleteMany({});
		await prisma.role.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	async function user(id: string) {
		return prisma.user.create({ data: { id, name: `User ${id}`, email: `${id}@example.com` } });
	}

	it("gives a fresh account nothing", async () => {
		const account = await user("u1");

		// The default that matters: an account created but not yet configured is inert.
		expect(await effectivePermissions(account.id)).toEqual(new Set());
	});

	it("counts a permission granted directly", async () => {
		const account = await user("u2");
		await prisma.userPermission.create({ data: { userId: account.id, permission: "devices:read" } });

		expect([...(await effectivePermissions(account.id))]).toEqual(["devices:read"]);
	});

	it("counts a permission carried by a role", async () => {
		const account = await user("u3");
		const role = await prisma.role.create({ data: { name: "Printer minder" } });
		await prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:pause" } });
		await prisma.userRole.create({ data: { userId: account.id, roleId: role.id } });

		expect([...(await effectivePermissions(account.id))]).toEqual(["devices:pause"]);
	});

	it("unions roles and direct grants without duplicating the overlap", async () => {
		const account = await user("u4");
		const role = await prisma.role.create({ data: { name: "Printer minder" } });
		await prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:read" } });
		await prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:pause" } });
		await prisma.userRole.create({ data: { userId: account.id, roleId: role.id } });
		await prisma.userPermission.create({ data: { userId: account.id, permission: "devices:read" } });
		await prisma.userPermission.create({ data: { userId: account.id, permission: "jobs:cancel" } });

		expect([...(await effectivePermissions(account.id))].sort()).toEqual([
			"devices:pause",
			"devices:read",
			"jobs:cancel",
		]);
	});

	it("drops a stored identifier this version no longer recognises", async () => {
		const account = await user("u5");
		await prisma.userPermission.create({ data: { userId: account.id, permission: "devices:teleport" } });
		await prisma.userPermission.create({ data: { userId: account.id, permission: "devices:read" } });

		// A grant nobody can name must not be treated as allowing something.
		expect([...(await effectivePermissions(account.id))]).toEqual(["devices:read"]);
	});

	it("says a superuser holds a permission they were never granted", async () => {
		const account = await user("u6");

		expect(await userHolds({ id: account.id, isSuperuser: true }, "settings:write:security")).toBe(true);
		expect(await userHolds({ id: account.id, isSuperuser: false }, "settings:write:security")).toBe(false);
	});

	it("says a superuser holds one that is never grantable", async () => {
		const account = await user("u7");
		// `users:set-superuser` is outside the grant system rather than the top of it: no row can
		// confer it, and a superuser holds it by being one.
		await prisma.userPermission.create({ data: { userId: account.id, permission: "users:set-superuser" } });

		expect(await userHolds({ id: account.id, isSuperuser: true }, "users:set-superuser")).toBe(true);
	});
});
