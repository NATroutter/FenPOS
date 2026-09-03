import { beforeEach, describe, expect, it } from "vitest";
import { permittedNavHrefs, sectionSwitchedOff } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

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
		await prisma.setting.deleteMany({ where: { key: { in: ["stats.enabled", "variables.enabled"] } } });
	});

	async function account(id: string, isSuperuser = false) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser } });
		return {
			id,
			name: id,
			email: `${id}@example.com`,
			isSuperuser,
			mustChangePassword: false,
			sessionId: `session-${id}`,
			twoFactorEnabled: false,
		};
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

		expect(await permittedNavHrefs(user)).toEqual(["/docs", "/docs/api", "/docs/markup", "/docs/security"]);
	});

	it("counts a permission carried by a role, not only a direct grant", async () => {
		const user = await account("p4");
		const role = await prisma.role.create({ data: { name: "Watcher" } });
		await prisma.rolePermission.create({ data: { roleId: role.id, permission: "logs:read" } });
		await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

		// Two sections, one permission: `logs:read` reveals the Logs tab and the Archives tab beside it,
		// because an archived period is the same lines through a different file.
		expect(await permittedNavHrefs(user)).toEqual(["/logs", "/archives"]);
	});

	/**
	 * The other half of `/archives`' `["logs:read", "audit:read"]`, and the reason a section may name
	 * more than one permission at all.
	 *
	 * A list means **any** of them. Goes red if it is ever read as "all of them", which would hide the
	 * Archives tab from the auditor who most needs it — and goes red just as surely if the section is
	 * put back to naming `logs:read` alone, because then this account is sent to `/no-access` by the
	 * one page whose job is saying where the record went.
	 */
	it("offers a section naming several permissions to an account holding just one of them", async () => {
		const user = await account("p6");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "audit:read" } });

		// Sidebar order: Audit now sits beside Logs and Archives in the Monitor group, ahead of Archives.
		expect(await permittedNavHrefs(user)).toEqual(["/audit", "/archives"]);
	});

	it("offers Users to an account that may read it, and not Roles", async () => {
		const user = await account("p5");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "users:read" } });

		// Two administration sections, two permissions. An account that may see the accounts is not
		// thereby allowed to see how roles are built.
		expect(await permittedNavHrefs(user)).toEqual(["/users"]);
	});

	/**
	 * A section switched off in Settings leaves the sidebar for everyone, superuser included. Whether
	 * the account *could* open it is a separate question, answered first and answered elsewhere.
	 */
	it("drops a section whose feature is switched off, whatever the account holds", async () => {
		const user = await account("f1", true);
		expect(await permittedNavHrefs(user)).toContain("/statistics");
		expect(await permittedNavHrefs(user)).toContain("/variables");

		await setSetting("stats.enabled", false);
		await setSetting("variables.enabled", false);

		const hrefs = await permittedNavHrefs(user);
		expect(hrefs).not.toContain("/statistics");
		expect(hrefs).not.toContain("/variables");
		// The switch removes its own section and nothing beside it.
		expect(hrefs).toContain("/dashboard");
		expect(hrefs).toContain("/assets");
	});
});

/**
 * The page-side half of the same switch: what `requirePagePermission` reads to decide whether to
 * refuse a route. Tested directly because the gate itself signals by redirecting, and a test that
 * mocked `redirect` away would be asserting against the mock.
 */
describe("sectionSwitchedOff", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany({ where: { key: { in: ["stats.enabled", "variables.enabled"] } } });
	});

	it("names the setting that has switched a section off", async () => {
		await setSetting("stats.enabled", false);

		expect(await sectionSwitchedOff("/statistics")).toBe("stats.enabled");
		expect(await sectionSwitchedOff("/variables")).toBeNull();
	});

	it("reads a section as available while its switch is on", async () => {
		expect(await sectionSwitchedOff("/statistics")).toBeNull();
		expect(await sectionSwitchedOff("/variables")).toBeNull();
	});

	it("never switches off a section that has no switch, or a route it does not know", async () => {
		await setSetting("stats.enabled", false);
		await setSetting("variables.enabled", false);

		expect(await sectionSwitchedOff("/jobs")).toBeNull();
		expect(await sectionSwitchedOff("/nowhere")).toBeNull();
	});
});
