import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

/**
 * The four grant tables, and the deletions they do and do not survive.
 *
 * The cascades are asserted against the database rather than read off the schema, because a
 * migration that dropped one would leave every other test around it passing and a deleted account's
 * grants sitting in a table waiting for its id to be reused.
 */
describe("grant schema", () => {
	beforeEach(async () => {
		await prisma.userPermission.deleteMany({});
		await prisma.userRole.deleteMany({});
		await prisma.rolePermission.deleteMany({});
		await prisma.role.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	/** An account with the fields Better Auth's own columns require. */
	async function user(id: string) {
		return prisma.user.create({ data: { id, name: `User ${id}`, email: `${id}@example.com` } });
	}

	it("refuses the same permission twice on one role", async () => {
		const role = await prisma.role.create({ data: { name: "Printer minder" } });
		await prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:read" } });

		await expect(
			prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:read" } }),
		).rejects.toThrow();
	});

	it("refuses two roles with the same name", async () => {
		await prisma.role.create({ data: { name: "Printer minder" } });

		await expect(prisma.role.create({ data: { name: "Printer minder" } })).rejects.toThrow();
	});

	it("takes a role's grants and memberships with it", async () => {
		const account = await user("u1");
		const role = await prisma.role.create({ data: { name: "Printer minder" } });
		await prisma.rolePermission.create({ data: { roleId: role.id, permission: "devices:read" } });
		await prisma.userRole.create({ data: { userId: account.id, roleId: role.id } });

		await prisma.role.delete({ where: { id: role.id } });

		expect(await prisma.rolePermission.count()).toBe(0);
		expect(await prisma.userRole.count()).toBe(0);
		// The account itself survives its role being deleted; it simply holds less.
		expect(await prisma.user.count()).toBe(1);
	});

	it("takes an account's grants and memberships with it", async () => {
		const account = await user("u2");
		const role = await prisma.role.create({ data: { name: "Printer minder" } });
		await prisma.userRole.create({ data: { userId: account.id, roleId: role.id } });
		await prisma.userPermission.create({ data: { userId: account.id, permission: "devices:delete" } });

		await prisma.user.delete({ where: { id: account.id } });

		// A grant is a statement about an account that exists. `AuditEvent` is the deliberate
		// opposite and is not asserted here — it has no relation to cascade along.
		expect(await prisma.userRole.count()).toBe(0);
		expect(await prisma.userPermission.count()).toBe(0);
		expect(await prisma.role.count()).toBe(1);
	});

	it("lets two accounts hold the same permission", async () => {
		const first = await user("u3");
		const second = await user("u4");

		await prisma.userPermission.create({ data: { userId: first.id, permission: "jobs:read" } });
		await prisma.userPermission.create({ data: { userId: second.id, permission: "jobs:read" } });

		expect(await prisma.userPermission.count()).toBe(2);
	});
});
