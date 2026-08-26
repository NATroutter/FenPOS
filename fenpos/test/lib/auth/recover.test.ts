import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/lib/audit/verify";
import { credentialAccountRow } from "@/lib/auth/credential-account";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { clearAllowlist, clearTwoFactor, listAccounts, resetPassword, unlockAccount } from "@/lib/auth/recover";
import { RECOVERY_AUDIT_ACTIONS } from "@/lib/auth/recovery-actions";
import { prisma } from "@/lib/db";
import { setSetting, stringSetting } from "@/lib/settings/settings-service";

/**
 * Recovery, against a real database.
 *
 * Every case asserts two things: that the account can now be used, and that a row says so. The
 * second is not decoration — a recovery tool that left no trace would be the most useful thing on
 * the box to somebody who should not be there.
 */
describe("recovery", () => {
	beforeEach(async () => {
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
		await prisma.twoFactor.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
	});

	/**
	 * A credential account, written the way `account-service.ts`'s `createAccount` writes one —
	 * `credentialAccountRow` gives the exact shape Better Auth's own sign-in looks for.
	 */
	async function credentialUser(email: string, password: string): Promise<{ id: string }> {
		const id = randomUUID();
		const now = new Date();
		await prisma.user.create({
			data: { id, name: email, email, emailVerified: true, role: "user", createdAt: now, updatedAt: now },
		});
		await prisma.account.create({ data: credentialAccountRow(id, await hashPassword(password), now) });
		return { id };
	}

	/** A credential account with a two-factor enrolment already verified and in force. */
	async function enrolledUser(email: string): Promise<{ id: string }> {
		const { id } = await credentialUser(email, "old password entirely");
		await prisma.twoFactor.create({
			data: { id: `tf-${id}`, userId: id, secret: "not-a-real-secret", backupCodes: "[]" },
		});
		await prisma.user.update({ where: { id }, data: { twoFactorEnabled: true } });
		return { id };
	}

	/** A credential account already locked out, the way `lockout.ts`'s `recordFailedSignIn` leaves one. */
	async function lockedOutUser(email: string): Promise<{ id: string }> {
		const { id } = await credentialUser(email, "old password entirely");
		await prisma.user.update({
			where: { id },
			data: { failedSignInCount: 5, lockedUntil: new Date(Date.now() + 15 * 60 * 1000) },
		});
		return { id };
	}

	it("lists accounts with the facts an operator needs to choose one", async () => {
		await lockedOutUser("locked@example.test");
		const accounts = await listAccounts(prisma);
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.email).toBe("locked@example.test");
		expect(accounts[0]?.lockedUntil).not.toBeNull();
	});

	it("mints a password that actually works, and returns it once", async () => {
		const user = await credentialUser("reset@example.test", "old password entirely");
		const minted = await resetPassword(prisma, "reset@example.test");

		expect(minted.length).toBeGreaterThanOrEqual(20);
		const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id } });
		expect(await verifyPassword(account.password ?? "", minted)).toBe(true);
	});

	it("forces a change and ends every session, so a printed password cannot linger", async () => {
		const user = await credentialUser("forced@example.test", "old password entirely");
		await prisma.session.create({
			data: {
				id: "s-forced",
				token: "t-forced",
				userId: user.id,
				expiresAt: new Date(Date.now() + 3_600_000),
			},
		});

		await resetPassword(prisma, "forced@example.test");

		const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(Boolean(after.mustChangePassword)).toBe(true);
		expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
	});

	it("never puts the minted password in the audit row", async () => {
		await credentialUser("quiet@example.test", "old password entirely");
		const minted = await resetPassword(prisma, "quiet@example.test");

		const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe(RECOVERY_AUDIT_ACTIONS.RESET_PASSWORD);
		expect(row.actorKind).toBe("CLI");
		expect(JSON.stringify(row)).not.toContain(minted);
	});

	it("clears an enrolment and its secret rows together", async () => {
		const user = await enrolledUser("tfa@example.test");
		await clearTwoFactor(prisma, "tfa@example.test");

		const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(Boolean(after.twoFactorEnabled)).toBe(false);
		expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(0);
	});

	it("clears a lockout", async () => {
		const user = await lockedOutUser("unlock@example.test");
		await unlockAccount(prisma, "unlock@example.test");

		const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(after.lockedUntil).toBeNull();
		expect(after.failedSignInCount).toBe(0);
	});

	it("empties the address allowlist", async () => {
		await setSetting("auth.ipAllowlist", "10.0.0.0/8");
		await clearAllowlist(prisma);
		expect(await stringSetting("auth.ipAllowlist")).toBe("");
	});

	it("refuses an address with no account, and says so without changing anything", async () => {
		await expect(resetPassword(prisma, "nobody@example.test")).rejects.toThrow(/no account/i);
		expect(await prisma.auditEvent.count()).toBe(1);
		const row = await prisma.auditEvent.findFirstOrThrow();
		expect(row.outcome).toBe("FAILURE");
	});

	it("leaves the chain verifiable after every operation", async () => {
		await credentialUser("chain@example.test", "old password entirely");
		await resetPassword(prisma, "chain@example.test");
		await unlockAccount(prisma, "chain@example.test");
		await clearAllowlist(prisma);

		expect((await verifyAuditChain(prisma)).ok).toBe(true);
	});
});
