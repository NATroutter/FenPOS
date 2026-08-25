import { beforeEach, describe, expect, it } from "vitest";
import { permittedNavGroups } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";

/**
 * What the sidebar offers.
 *
 * Convenience, not a boundary — the page check is the boundary. It is worth testing anyway because
 * the failure is quiet in both directions: a section shown that cannot be opened reads as a broken
 * panel, and a group left rendering with nothing under it is a heading pointing at nothing.
 */
describe("permittedNavGroups", () => {
	beforeEach(async () => {
		await prisma.userPermission.deleteMany({});
		await prisma.userRole.deleteMany({});
		await prisma.rolePermission.deleteMany({});
		await prisma.role.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	async function account(id: string, isSuperuser = false) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser } });
		return { id, name: id, email: `${id}@example.com`, isSuperuser, mustChangePassword: false };
	}

	it("offers a superuser everything", async () => {
		const groups = await permittedNavGroups(await account("s1", true));

		expect(groups.map((group) => group.label)).toEqual(["Operations", "Hardware", "Administration"]);
	});

	it("offers an account with nothing no sections at all", async () => {
		expect(await permittedNavGroups(await account("n1"))).toEqual([]);
	});

	it("offers only the sections an account holds", async () => {
		const user = await account("p1");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "jobs:read" } });

		const groups = await permittedNavGroups(user);

		expect(groups).toHaveLength(1);
		expect(groups[0].items.map((item) => item.href)).toEqual(["/jobs"]);
	});

	it("drops a group whose every section was filtered out", async () => {
		const user = await account("p2");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "devices:read" } });

		const groups = await permittedNavGroups(user);

		// A heading with nothing under it is worse than no heading.
		expect(groups.map((group) => group.label)).toEqual(["Hardware"]);
	});

	it("keeps a parent's children when they are permitted too", async () => {
		const user = await account("p3");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "docs:read" } });

		const docs = (await permittedNavGroups(user)).flatMap((group) => group.items).find((item) => item.href === "/docs");

		expect(docs?.children?.map((child) => child.href)).toEqual(["/docs/api", "/docs/markup"]);
	});

	it("counts a permission carried by a role, not only a direct grant", async () => {
		const user = await account("p4");
		const role = await prisma.role.create({ data: { name: "Watcher" } });
		await prisma.rolePermission.create({ data: { roleId: role.id, permission: "logs:read" } });
		await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

		const groups = await permittedNavGroups(user);

		expect(groups.flatMap((group) => group.items).map((item) => item.href)).toEqual(["/logs"]);
	});
});
