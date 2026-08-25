import { beforeEach, describe, expect, it } from "vitest";
import { permittedNavHrefs } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";

/**
 * What the sidebar offers.
 *
 * Convenience, not a boundary — the page check is the boundary. It is worth testing anyway because
 * the failure is quiet in both directions: a section shown that cannot be opened reads as a broken
 * panel, and a group left rendering with nothing under it is a heading pointing at nothing.
 *
 * **The serialisation test is the one that carries weight.** This function's result crosses from the
 * server layout into a Client Component, and an earlier version returned the `NavItem`s themselves —
 * each carrying `icon`, a function component. React refuses a function across that boundary, and it
 * refuses it fatally: every page under the panel layout rendered "This page couldn't load". No test
 * caught it, because nothing asserted what actually crossed. This does.
 */
describe("permittedNavHrefs", () => {
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

	it("returns something a Server Component may hand a Client Component", async () => {
		const hrefs = await permittedNavHrefs(await account("s0", true));

		// Two assertions, and the second is the real one: a value that survives a JSON round trip
		// unchanged carries no functions, no class instances and nothing else React would refuse.
		for (const href of hrefs) {
			expect(typeof href).toBe("string");
		}
		expect(JSON.parse(JSON.stringify(hrefs))).toEqual(hrefs);
	});

	it("offers a superuser everything", async () => {
		const hrefs = await permittedNavHrefs(await account("s1", true));

		expect(hrefs).toContain("/dashboard");
		expect(hrefs).toContain("/settings");
		expect(hrefs).toContain("/docs/api");
	});

	it("offers an account with nothing no sections at all", async () => {
		expect(await permittedNavHrefs(await account("n1"))).toEqual([]);
	});

	it("offers only the sections an account holds", async () => {
		const user = await account("p1");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "jobs:read" } });

		expect(await permittedNavHrefs(user)).toEqual(["/jobs"]);
	});

	it("keeps a parent's children when they are permitted too", async () => {
		const user = await account("p3");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "docs:read" } });

		expect(await permittedNavHrefs(user)).toEqual(["/docs", "/docs/api", "/docs/markup"]);
	});

	it("counts a permission carried by a role, not only a direct grant", async () => {
		const user = await account("p4");
		const role = await prisma.role.create({ data: { name: "Watcher" } });
		await prisma.rolePermission.create({ data: { roleId: role.id, permission: "logs:read" } });
		await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

		expect(await permittedNavHrefs(user)).toEqual(["/logs"]);
	});

	it("offers Users to an account that may read it, and not Roles", async () => {
		const user = await account("p5");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "users:read" } });

		// Two administration sections, two permissions. An account that may see the accounts is not
		// thereby allowed to see how roles are built.
		expect(await permittedNavHrefs(user)).toEqual(["/users"]);
	});
});
