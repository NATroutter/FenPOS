import { beforeEach, describe, expect, it } from "vitest";
import {
	createAccount,
	deleteAccount,
	listAccounts,
	setAccountSuperuser,
	updateAccount,
} from "@/lib/auth/account-service";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db";

/**
 * Creating, changing and removing accounts.
 *
 * The load-bearing assertions are the ones about what an account arrives holding: a new account is
 * inert unless somebody decided otherwise, its creator cannot decide beyond their own authority,
 * and a "require password reset" tick means the account genuinely cannot reach the panel without
 * changing it. The sign-in assertion is here rather than in a route test because the credential row
 * is written by hand: nothing else proves the hand-written row is the one Better Auth looks for.
 *
 * Fresh account ids throughout — `effectivePermissions` memoises per id for the life of the
 * process. See the Global Constraints.
 */
describe("account-service", () => {
	beforeEach(async () => {
		await prisma.userPermission.deleteMany({});
		await prisma.userRole.deleteMany({});
		await prisma.rolePermission.deleteMany({});
		await prisma.role.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
	});

	/** A superuser to act as, which the guard functions treat as able to grant anything. */
	async function superuser(id: string) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser: true } });
		return { id, isSuperuser: true };
	}

	/** An ordinary account holding exactly the listed permissions. */
	async function holder(id: string, permissions: string[]) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com` } });
		for (const permission of permissions) {
			await prisma.userPermission.create({ data: { userId: id, permission } });
		}
		return { id, isSuperuser: false };
	}

	const newAccount = {
		name: "Sam Operator",
		email: "sam@example.com",
		password: "a-long-enough-password",
		requirePasswordReset: false,
		roleIds: [],
		permissions: [],
	};

	describe("createAccount", () => {
		it("creates an account that can sign in with the password it was given", async () => {
			const actor = await superuser("c1");

			await createAccount(actor, newAccount);

			const signedIn = await auth.api.signInEmail({
				body: { email: "sam@example.com", password: newAccount.password },
			});
			expect(signedIn.user.email).toBe("sam@example.com");
		});

		it("creates it holding nothing at all when nothing was chosen", async () => {
			const actor = await superuser("c2");

			const { userId } = await createAccount(actor, newAccount);

			expect(await prisma.userPermission.count({ where: { userId } })).toBe(0);
			expect(await prisma.userRole.count({ where: { userId } })).toBe(0);
		});

		it("is never a superuser, whatever was submitted", async () => {
			const actor = await superuser("c3");

			const { userId } = await createAccount(actor, {
				...newAccount,
				// The field is not on the input type; this is what a crafted call would carry.
				...({ isSuperuser: true } as object),
			});

			const created = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
			expect(created.isSuperuser).toBe(false);
			expect(created.role).toBe("user");
		});

		it("marks the account for a forced reset when asked", async () => {
			const actor = await superuser("c4");

			const { userId } = await createAccount(actor, { ...newAccount, requirePasswordReset: true });

			expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mustChangePassword).toBe(true);
		});

		it("normalises the address, so two accounts cannot differ only by case", async () => {
			const actor = await superuser("c5");
			await createAccount(actor, { ...newAccount, email: "Sam@Example.com" });

			await expect(createAccount(actor, newAccount)).rejects.toThrow(/already in use/i);
		});

		it("refuses a password below the install's configured minimum", async () => {
			const actor = await superuser("c6");
			await prisma.setting.create({ data: { key: "auth.minimumPasswordLength", value: "30" } });

			await expect(createAccount(actor, newAccount)).rejects.toThrow(/at least 30 characters/i);
		});

		it("refuses a grant the creator does not hold, and writes no account at all", async () => {
			const actor = await holder("c7", ["users:create"]);

			await expect(createAccount(actor, { ...newAccount, permissions: ["settings:write:security"] })).rejects.toThrow(
				/do not hold/i,
			);
			expect(await prisma.user.findFirst({ where: { email: "sam@example.com" } })).toBeNull();
		});

		it("refuses a role carrying more than the creator holds", async () => {
			const actor = await holder("c8", ["users:create", "devices:read"]);
			const role = await prisma.role.create({ data: { name: "Security" } });
			await prisma.rolePermission.create({ data: { roleId: role.id, permission: "settings:write:security" } });

			await expect(createAccount(actor, { ...newAccount, roleIds: [role.id] })).rejects.toThrow(/do not hold/i);
		});

		it("applies the grants and roles it was given", async () => {
			const actor = await superuser("c9");
			const role = await prisma.role.create({ data: { name: "Minder" } });

			const { userId } = await createAccount(actor, {
				...newAccount,
				roleIds: [role.id],
				permissions: ["devices:read", "jobs:cancel"],
			});

			expect(await prisma.userPermission.count({ where: { userId } })).toBe(2);
			expect(await prisma.userRole.count({ where: { userId, roleId: role.id } })).toBe(1);
		});
	});

	describe("listAccounts", () => {
		it("reports what each account holds, and how many sessions it has open", async () => {
			const actor = await superuser("l1");
			const role = await prisma.role.create({ data: { name: "Minder" } });
			const { userId } = await createAccount(actor, {
				...newAccount,
				roleIds: [role.id],
				permissions: ["devices:read"],
			});
			await prisma.session.create({
				data: {
					id: "sess-l1",
					userId,
					token: "token-l1",
					expiresAt: new Date(Date.now() + 60_000),
				},
			});

			const listed = (await listAccounts()).find((account) => account.id === userId);

			expect(listed?.permissions).toEqual(["devices:read"]);
			expect(listed?.roles.map((entry) => entry.name)).toEqual(["Minder"]);
			expect(listed?.sessionCount).toBe(1);
		});

		it("drops a stored identifier this version no longer recognises", async () => {
			const actor = await superuser("l2");
			const { userId } = await createAccount(actor, newAccount);
			await prisma.userPermission.create({ data: { userId, permission: "devices:teleport" } });

			const listed = (await listAccounts()).find((account) => account.id === userId);

			expect(listed?.permissions).toEqual([]);
		});
	});

	describe("updateAccount", () => {
		it("changes the name and the address", async () => {
			const actor = await superuser("u1");
			const { userId } = await createAccount(actor, newAccount);

			await updateAccount(userId, "Sam Renamed", "renamed@example.com");

			const updated = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
			expect(updated.name).toBe("Sam Renamed");
			expect(updated.email).toBe("renamed@example.com");
		});

		it("refuses an address another account already has", async () => {
			const actor = await superuser("u2");
			const { userId } = await createAccount(actor, newAccount);

			await expect(updateAccount(userId, "Sam", "u2@example.com")).rejects.toThrow(/already in use/i);
		});

		it("refuses an empty name", async () => {
			const actor = await superuser("u3");
			const { userId } = await createAccount(actor, newAccount);

			await expect(updateAccount(userId, "   ", "sam@example.com")).rejects.toThrow(/name is required/i);
		});
	});

	describe("deleteAccount", () => {
		it("removes the account, its credential, its sessions and its grants", async () => {
			const actor = await superuser("d1");
			const { userId } = await createAccount(actor, { ...newAccount, permissions: ["devices:read"] });

			await deleteAccount(actor, userId);

			expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
			expect(await prisma.account.count({ where: { userId } })).toBe(0);
			expect(await prisma.userPermission.count({ where: { userId } })).toBe(0);
		});

		it("refuses to delete the account doing the deleting", async () => {
			const actor = await superuser("d2");

			await expect(deleteAccount(actor, actor.id)).rejects.toThrow(/your own account/i);
		});

		it("refuses to delete the last superuser", async () => {
			const actor = await superuser("d3");
			const other = await superuser("d4");
			await prisma.user.update({ where: { id: other.id }, data: { isSuperuser: false } });

			await expect(deleteAccount({ id: other.id, isSuperuser: false }, actor.id)).rejects.toThrow(/last superuser/i);
		});
	});

	describe("setAccountSuperuser", () => {
		it("promotes an account, and gives Better Auth's own role string the same answer", async () => {
			const actor = await superuser("s1");
			const { userId } = await createAccount(actor, newAccount);

			await setAccountSuperuser(actor, userId, true);

			const promoted = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
			expect(promoted.isSuperuser).toBe(true);
			expect(promoted.role).toBe("admin");
		});

		it("demotes an account that is not the last superuser", async () => {
			const actor = await superuser("s2");
			const other = await superuser("s3");

			await setAccountSuperuser(actor, other.id, false);

			const demoted = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
			expect(demoted.isSuperuser).toBe(false);
			expect(demoted.role).toBe("user");
		});

		it("refuses to demote the last superuser", async () => {
			const actor = await superuser("s4");
			const target = await holder("s5", []);

			await expect(setAccountSuperuser({ id: target.id, isSuperuser: false }, actor.id, false)).rejects.toThrow(
				/last superuser/i,
			);
		});

		it("refuses to demote yourself", async () => {
			const actor = await superuser("s6");
			await superuser("s7");

			await expect(setAccountSuperuser(actor, actor.id, false)).rejects.toThrow(/your own account/i);
		});
	});
});
