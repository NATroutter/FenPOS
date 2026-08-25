import { beforeEach, describe, expect, it } from "vitest";
import {
	banAccount,
	clearTwoFactor,
	listAccountSessions,
	requirePasswordChange,
	revokeAccountSession,
	revokeAccountSessions,
	setAccountPassword,
	unbanAccount,
} from "@/lib/auth/account-security";
import { createAccount } from "@/lib/auth/account-service";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db";

/**
 * Everything that ends or restrains an account's access.
 *
 * Every assertion here is about immediacy, because immediacy is the whole reason this install kept
 * database-backed sessions instead of taking the JWTs the alternative library steers callers to. A
 * password replaced, a ban applied or a session revoked has to bite now — not when a token happens
 * to expire.
 *
 * The ban tests are the ones that would otherwise be assumed. `banned` is read by exactly one hook
 * in the library, on session *creation*: it refuses the next sign-in and does nothing at all to the
 * tab that is already open. So both halves are asserted separately.
 */
describe("account-security", () => {
	beforeEach(async () => {
		await prisma.twoFactor.deleteMany({});
		await prisma.userPermission.deleteMany({});
		await prisma.userRole.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
	});

	async function superuser(id: string) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser: true } });
		return { id, isSuperuser: true };
	}

	/** An account created through the real service, so its credential row is the real shape. */
	async function subject(actorId: string, email = "sam@example.com") {
		const actor = await superuser(actorId);
		const { userId } = await createAccount(actor, {
			name: "Sam Operator",
			email,
			password: "a-long-enough-password",
			requirePasswordReset: false,
			roleIds: [],
			permissions: [],
		});
		return { actor, userId, email };
	}

	/** A session row for an account, as `session.create` would leave one. */
	async function session(userId: string, id: string) {
		return prisma.session.create({
			data: {
				id,
				userId,
				token: `token-${id}`,
				expiresAt: new Date(Date.now() + 60_000),
				ipAddress: "10.0.0.7",
				userAgent: "Firefox",
			},
		});
	}

	describe("setAccountPassword", () => {
		it("replaces the password, so the new one signs in and the old one does not", async () => {
			const { userId, email } = await subject("p1");

			await setAccountPassword(userId, "a-completely-different-password");

			await expect(
				auth.api.signInEmail({ body: { email, password: "a-completely-different-password" } }),
			).resolves.toMatchObject({ user: { email } });
			await expect(auth.api.signInEmail({ body: { email, password: "a-long-enough-password" } })).rejects.toThrow();
		});

		it("ends every session the account had open", async () => {
			const { userId } = await subject("p2", "p2-sam@example.com");
			await session(userId, "sess-p2");

			await setAccountPassword(userId, "a-completely-different-password");

			// The property database-backed sessions were kept for: a password change ends other
			// sessions now, not when a token expires.
			expect(await prisma.session.count({ where: { userId } })).toBe(0);
		});

		it("refuses a password below the install's configured minimum", async () => {
			const { userId } = await subject("p3", "p3-sam@example.com");
			await prisma.setting.create({ data: { key: "auth.minimumPasswordLength", value: "30" } });

			await expect(setAccountPassword(userId, "a-long-enough-password")).rejects.toThrow(/at least 30 characters/i);
		});

		it("refuses an account with no credential rather than silently writing none", async () => {
			await prisma.user.create({ data: { id: "p4", name: "p4", email: "p4@example.com" } });

			await expect(setAccountPassword("p4", "a-long-enough-password")).rejects.toThrow(/no password/i);
		});
	});

	describe("requirePasswordChange", () => {
		it("marks the account and ends its sessions", async () => {
			const { userId } = await subject("f1", "f1-sam@example.com");
			await session(userId, "sess-f1");

			await requirePasswordChange(userId);

			expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mustChangePassword).toBe(true);
			// Without this the operator keeps browsing on the session they already have, and the reset
			// they are supposed to be blocked by never appears until they sign out.
			expect(await prisma.session.count({ where: { userId } })).toBe(0);
		});
	});

	describe("banAccount", () => {
		it("records the reason and the expiry", async () => {
			const { actor, userId } = await subject("b1", "b1-sam@example.com");
			const until = new Date(Date.now() + 86_400_000);

			await banAccount(actor, userId, "Left the company", until);

			const banned = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
			expect(banned.banned).toBe(true);
			expect(banned.banReason).toBe("Left the company");
			expect(banned.banExpires?.getTime()).toBe(until.getTime());
		});

		it("ends the sessions the account already had", async () => {
			const { actor, userId } = await subject("b2", "b2-sam@example.com");
			await session(userId, "sess-b2");

			await banAccount(actor, userId, "Left the company", null);

			// The library's own check runs on session creation only. Without this deletion the banned
			// operator's open tab keeps working.
			expect(await prisma.session.count({ where: { userId } })).toBe(0);
		});

		it("stops the account signing in again", async () => {
			const { actor, userId, email } = await subject("b3", "b3-sam@example.com");

			await banAccount(actor, userId, "Left the company", null);

			await expect(auth.api.signInEmail({ body: { email, password: "a-long-enough-password" } })).rejects.toThrow();
		});

		it("refuses to ban the account doing the banning", async () => {
			const actor = await superuser("b4");

			await expect(banAccount(actor, actor.id, "Slipped", null)).rejects.toThrow(/your own account/i);
		});

		it("refuses to ban the last superuser", async () => {
			const actor = await superuser("b5");
			const target = await superuser("b6");
			await prisma.user.update({ where: { id: actor.id }, data: { isSuperuser: false } });

			await expect(banAccount({ id: actor.id, isSuperuser: false }, target.id, "No", null)).rejects.toThrow(
				/last superuser/i,
			);
		});

		it("refuses an empty reason", async () => {
			const { actor, userId } = await subject("b7", "b7-sam@example.com");

			// A ban with no reason is a row nobody can act on six months later.
			await expect(banAccount(actor, userId, "   ", null)).rejects.toThrow(/reason is required/i);
		});
	});

	describe("unbanAccount", () => {
		it("clears the flag, the reason and the expiry together", async () => {
			const { actor, userId, email } = await subject("n1", "n1-sam@example.com");
			await banAccount(actor, userId, "Left the company", new Date(Date.now() + 86_400_000));

			await unbanAccount(userId);

			const lifted = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
			expect(lifted.banned).toBe(false);
			expect(lifted.banReason).toBeNull();
			expect(lifted.banExpires).toBeNull();
			await expect(auth.api.signInEmail({ body: { email, password: "a-long-enough-password" } })).resolves.toBeTruthy();
		});
	});

	describe("sessions", () => {
		it("lists what an account has open, newest first, with where from", async () => {
			const { userId } = await subject("v1", "v1-sam@example.com");
			await session(userId, "sess-v1");

			const [open] = await listAccountSessions(userId);

			expect(open.id).toBe("sess-v1");
			expect(open.ipAddress).toBe("10.0.0.7");
			expect(open.userAgent).toBe("Firefox");
		});

		it("revokes one session and leaves the others", async () => {
			const { userId } = await subject("v2", "v2-sam@example.com");
			await session(userId, "sess-v2a");
			await session(userId, "sess-v2b");

			await revokeAccountSession("sess-v2a");

			expect((await listAccountSessions(userId)).map((open) => open.id)).toEqual(["sess-v2b"]);
		});

		it("revokes every session an account holds", async () => {
			const { userId } = await subject("v3", "v3-sam@example.com");
			await session(userId, "sess-v3a");
			await session(userId, "sess-v3b");

			await revokeAccountSessions(userId);

			expect(await listAccountSessions(userId)).toEqual([]);
		});

		it("reports no error when there is nothing to revoke", async () => {
			const { userId } = await subject("v4", "v4-sam@example.com");

			// The operator's intent — "this account should have no sessions" — is satisfied either way.
			await expect(revokeAccountSessions(userId)).resolves.toBeUndefined();
		});
	});

	describe("clearTwoFactor", () => {
		it("removes the enrolment and the flag together", async () => {
			const { userId } = await subject("t1", "t1-sam@example.com");
			await prisma.twoFactor.create({
				data: { id: "tf-t1", userId, secret: "not-a-real-secret", backupCodes: "[]" },
			});
			await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });

			await clearTwoFactor(userId);

			expect(await prisma.twoFactor.count({ where: { userId } })).toBe(0);
			// Both, or the account is offered a challenge it has no secret to answer.
			expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).twoFactorEnabled).toBe(false);
		});

		it("reports no error for an account that was never enrolled", async () => {
			const { userId } = await subject("t2", "t2-sam@example.com");

			await expect(clearTwoFactor(userId)).resolves.toBeUndefined();
		});
	});
});
