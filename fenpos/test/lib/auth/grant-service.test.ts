import { beforeEach, describe, expect, it } from "vitest";
import { effectivePermissions } from "@/lib/auth/effective-permissions";
import { setAccountPermissions, setAccountRoles } from "@/lib/auth/grant-service";
import { prisma } from "@/lib/db";

/**
 * Replacing what an account holds, without reaching past what the editor holds.
 *
 * The escalation half is obvious and `grant-guard.test.ts` already covers it. What is tested here is
 * the half that is easy to miss entirely: an editor who cannot see a grant must not be able to
 * *remove* it by saving a form. The checkbox for it is not rendered, so a wholesale replace would
 * strip it — de-escalation by somebody with no authority over it, which is the same bug the other
 * way round.
 *
 * Fresh account ids throughout — `effectivePermissions` memoises per id for the life of the
 * process. See the Global Constraints.
 */
describe("grant-service", () => {
	beforeEach(async () => {
		await prisma.userPermission.deleteMany({});
		await prisma.userRole.deleteMany({});
		await prisma.rolePermission.deleteMany({});
		await prisma.role.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	async function account(id: string, permissions: string[], isSuperuser = false) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser } });
		for (const permission of permissions) {
			await prisma.userPermission.create({ data: { userId: id, permission } });
		}
		return { id, isSuperuser };
	}

	/** What the account holds directly, read back from the rows rather than from the memo. */
	async function granted(userId: string): Promise<string[]> {
		const rows = await prisma.userPermission.findMany({ where: { userId }, select: { permission: true } });
		return rows.map((row) => row.permission).sort();
	}

	describe("setAccountPermissions", () => {
		it("replaces the set for a superuser, who may touch all of it", async () => {
			const actor = await account("q1", [], true);
			await account("q2", ["devices:read", "jobs:cancel"]);

			await setAccountPermissions(actor, "q2", ["logs:read"]);

			expect(await granted("q2")).toEqual(["logs:read"]);
		});

		it("keeps a grant the editor has no authority over", async () => {
			const actor = await account("q3", ["users:grant", "devices:read"]);
			await account("q4", ["devices:read", "settings:write:security"]);

			// The editor cannot see `settings:write:security` on the form, so their submission cannot
			// carry it back. Stripping it would be a change they were never allowed to make.
			await setAccountPermissions(actor, "q4", ["devices:read"]);

			expect(await granted("q4")).toEqual(["devices:read", "settings:write:security"]);
		});

		it("removes a grant the editor does hold and did not resubmit", async () => {
			const actor = await account("q5", ["users:grant", "devices:read", "jobs:cancel"]);
			await account("q6", ["devices:read", "jobs:cancel"]);

			await setAccountPermissions(actor, "q6", ["devices:read"]);

			expect(await granted("q6")).toEqual(["devices:read"]);
		});

		it("refuses a submission naming something the editor does not hold", async () => {
			const actor = await account("q7", ["users:grant", "devices:read"]);
			await account("q8", []);

			// Refused, not silently dropped: an escalation attempt that appears to succeed is worse
			// than one that is turned down.
			await expect(setAccountPermissions(actor, "q8", ["keys:create"])).rejects.toThrow(/do not hold/i);
			expect(await granted("q8")).toEqual([]);
		});

		it("refuses a permission no grant can hand out", async () => {
			const actor = await account("q9", [], true);
			await account("q10", []);

			await expect(setAccountPermissions(actor, "q10", ["users:set-superuser"])).rejects.toThrow(/never be granted/i);
		});

		it("writes no duplicate row when a retained grant is also resubmitted", async () => {
			const actor = await account("q11", [], true);
			await account("q12", ["devices:read"]);

			await setAccountPermissions(actor, "q12", ["devices:read", "devices:read"]);

			expect(await granted("q12")).toEqual(["devices:read"]);
		});

		it("takes effect on what the account can actually do", async () => {
			const actor = await account("q13", [], true);
			await account("q14", []);

			await setAccountPermissions(actor, "q14", ["logs:read"]);

			expect([...(await effectivePermissions("q14"))]).toEqual(["logs:read"]);
		});
	});

	describe("setAccountRoles", () => {
		it("replaces the roles for a superuser", async () => {
			const actor = await account("w1", [], true);
			await account("w2", []);
			const first = await prisma.role.create({ data: { name: "First" } });
			const second = await prisma.role.create({ data: { name: "Second" } });
			await prisma.userRole.create({ data: { userId: "w2", roleId: first.id } });

			await setAccountRoles(actor, "w2", [second.id]);

			const held = await prisma.userRole.findMany({ where: { userId: "w2" }, select: { roleId: true } });
			expect(held.map((row) => row.roleId)).toEqual([second.id]);
		});

		it("keeps a role the editor could not have assigned", async () => {
			const actor = await account("w3", ["users:grant", "devices:read"]);
			await account("w4", []);
			const reachable = await prisma.role.create({ data: { name: "Reachable" } });
			await prisma.rolePermission.create({ data: { roleId: reachable.id, permission: "devices:read" } });
			const beyond = await prisma.role.create({ data: { name: "Beyond" } });
			await prisma.rolePermission.create({ data: { roleId: beyond.id, permission: "settings:write:security" } });
			await prisma.userRole.create({ data: { userId: "w4", roleId: beyond.id } });

			await setAccountRoles(actor, "w4", [reachable.id]);

			const held = await prisma.userRole.findMany({ where: { userId: "w4" }, select: { roleId: true } });
			expect(held.map((row) => row.roleId).sort()).toEqual([beyond.id, reachable.id].sort());
		});

		it("refuses a role carrying more than the editor holds", async () => {
			const actor = await account("w5", ["users:grant", "devices:read"]);
			await account("w6", []);
			const beyond = await prisma.role.create({ data: { name: "Beyond" } });
			await prisma.rolePermission.create({ data: { roleId: beyond.id, permission: "settings:write:security" } });

			await expect(setAccountRoles(actor, "w6", [beyond.id])).rejects.toThrow(/do not hold/i);
			expect(await prisma.userRole.count({ where: { userId: "w6" } })).toBe(0);
		});

		it("removes every role when none is submitted", async () => {
			const actor = await account("w7", [], true);
			await account("w8", []);
			const role = await prisma.role.create({ data: { name: "Leaving" } });
			await prisma.userRole.create({ data: { userId: "w8", roleId: role.id } });

			await setAccountRoles(actor, "w8", []);

			expect(await prisma.userRole.count({ where: { userId: "w8" } })).toBe(0);
		});
	});
});
