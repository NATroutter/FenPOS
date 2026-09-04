import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAuditChain } from "@/lib/audit/verify";
import { credentialAccountRow } from "@/lib/auth/credential-account";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
	clearAllowlist,
	clearTwoFactor,
	disableChallenge,
	listAccounts,
	RecoveryRefusal,
	resetPassword,
	unlockAccount,
} from "@/lib/auth/recover";
import { RECOVERY_AUDIT_ACTIONS } from "@/lib/auth/recovery-actions";
import { auditDb, prisma } from "@/lib/db";
import { booleanSetting, secretSetting, setSetting, stringSetting } from "@/lib/settings/settings-service";

/**
 * Recovery, against a real database.
 *
 * Every case asserts two things: that the account can now be used, and that a row says so. The
 * second is not decoration — a recovery tool that left no trace would be the most useful thing on
 * the box to somebody who should not be there.
 *
 * Both clients are passed in because the two halves are in two database files: the account changes
 * land in the application database and the rows describing them in `audit.db`. That is also why the
 * account assertions read through `prisma` and the row assertions through `auditDb` — there is no
 * join between them to write.
 */
describe("recovery", () => {
	beforeEach(async () => {
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
		await auditDb.auditEpoch.deleteMany({});
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

	/**
	 * The one state in the listing that **no** command in this module clears, which is exactly why it
	 * has to be in the listing: an operator who resets a banned account's password otherwise gets a
	 * working credential, an account that still cannot sign in, and nothing on screen explaining the
	 * difference. Both values are asserted, so a field hardcoded to either one goes red.
	 */
	it("reports a ban, the one refusal no recovery command lifts", async () => {
		const { id } = await credentialUser("banned@example.test", "old password entirely");
		await prisma.user.update({ where: { id }, data: { banned: true } });
		await credentialUser("welcome@example.test", "old password entirely");

		const accounts = await listAccounts(prisma);

		expect(accounts.map((account) => [account.email, account.banned])).toEqual([
			["banned@example.test", true],
			["welcome@example.test", false],
		]);
	});

	it("mints a password that actually works, and returns it once", async () => {
		const user = await credentialUser("reset@example.test", "old password entirely");
		const minted = await resetPassword(prisma, auditDb, "reset@example.test");

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

		await resetPassword(prisma, auditDb, "forced@example.test");

		const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(Boolean(after.mustChangePassword)).toBe(true);
		expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
	});

	it("never puts the minted password in the audit row", async () => {
		await credentialUser("quiet@example.test", "old password entirely");
		const minted = await resetPassword(prisma, auditDb, "quiet@example.test");

		const row = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe(RECOVERY_AUDIT_ACTIONS.RESET_PASSWORD);
		expect(row.actorKind).toBe("CLI");
		expect(JSON.stringify(row)).not.toContain(minted);
	});

	it("clears an enrolment and its secret rows together", async () => {
		const user = await enrolledUser("tfa@example.test");
		await clearTwoFactor(prisma, auditDb, "tfa@example.test");

		const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(Boolean(after.twoFactorEnabled)).toBe(false);
		expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(0);
	});

	it("clears a lockout", async () => {
		const user = await lockedOutUser("unlock@example.test");
		await unlockAccount(prisma, auditDb, "unlock@example.test");

		const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(after.lockedUntil).toBeNull();
		expect(after.failedSignInCount).toBe(0);
	});

	it("empties the address allowlist", async () => {
		await setSetting("auth.ipAllowlist", "10.0.0.0/8");
		await clearAllowlist(prisma, auditDb);
		expect(await stringSetting("auth.ipAllowlist")).toBe("");
	});

	it("switches the bot challenge off and leaves both keys where they are", async () => {
		await setSetting("auth.turnstileEnabled", true);
		await setSetting("auth.turnstileSiteKey", "0x4AAAAAAAsitekey");
		await setSetting("auth.turnstileSecretKey", "0x4AAAAAAAsecret");

		await disableChallenge(prisma, auditDb);

		expect(await booleanSetting("auth.turnstileEnabled")).toBe(false);
		// The keys survive on purpose: this exists for a key Cloudflare refuses, and the operator fixes
		// that at Cloudflare and switches the challenge back on rather than retyping the pair.
		expect(await stringSetting("auth.turnstileSiteKey")).toBe("0x4AAAAAAAsitekey");
		expect(await secretSetting("auth.turnstileSecretKey")).toBe("0x4AAAAAAAsecret");
	});

	it("switches the challenge off on an install that never stored the setting", async () => {
		// The row does not exist until somebody saves the setting, so the upsert's create arm is what
		// runs on an install whose challenge was switched on and never off again. A command that only
		// worked where a row already existed would be a no-op exactly when it is needed.
		expect(await prisma.setting.findUnique({ where: { key: "auth.turnstileEnabled" } })).toBeNull();

		await disableChallenge(prisma, auditDb);

		expect(await booleanSetting("auth.turnstileEnabled")).toBe(false);
	});

	it("records that the challenge was switched off", async () => {
		await disableChallenge(prisma, auditDb);

		const row = await auditDb.auditEvent.findFirstOrThrow();
		expect(row.action).toBe(RECOVERY_AUDIT_ACTIONS.DISABLE_CHALLENGE);
		expect(row.outcome).toBe("SUCCESS");
		// `checked` as well as `ok`, for the reason the chain test at the bottom of this file gives:
		// an intact chain of nothing also answers `ok`.
		expect(await verifyAuditChain(auditDb)).toMatchObject({ ok: true, checked: 1 });
	});

	it("refuses an address with no account, and says so without changing anything", async () => {
		await expect(resetPassword(prisma, auditDb, "nobody@example.test")).rejects.toThrow(/no account/i);
		expect(await auditDb.auditEvent.count()).toBe(1);
		const row = await auditDb.auditEvent.findFirstOrThrow();
		expect(row.outcome).toBe("FAILURE");
	});

	it("throws RecoveryRefusal, naming the address, for an address matching no account", async () => {
		// The CLI-visible half of the guarantee the module comment makes: a caller can `instanceof`
		// this to print "that address is not right" rather than "check the logs" — and the typo'd
		// address, the commonest mistake, has to actually be in the message for that to be useful at
		// the worst possible moment.
		await expect(resetPassword(prisma, auditDb, "TYPO'd-Address@Example.Test")).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(RecoveryRefusal);
			expect((error as Error).message).toContain("typo'd-address@example.test");
			return true;
		});
	});

	it("refuses an account with no credential, and never lets the audit row carry a hash", async () => {
		// A `User` row with no `Account` row at all — never went through `credentialUser`, so there is
		// no credential for `resetPassword` to update. This is the one path in the whole module that
		// mints a password, hashes it, and *then* fails.
		//
		// **The hash assertion below is documentation, not the guard.** What reaches `recordFailure` on
		// this path is a `RecoveryRefusal` this module authored, and its message names an address and
		// nothing else — so `not.toContain("$argon2id$")` here holds even with the
		// `UNEXPECTED_FAILURE_REASON` substitution deleted outright. The case that actually pins that
		// substitution is the next one, "records an unexpected failure's fixed reason": it forces a
		// *raw* exception carrying an argon2-shaped sentinel out of a `perform`, and it goes red.
		await prisma.user.create({
			data: { id: "no-credential", name: "No Credential", email: "nocred@example.test" },
		});

		await expect(resetPassword(prisma, auditDb, "nocred@example.test")).rejects.toThrow(/no password credential/i);

		expect(await auditDb.auditEvent.count()).toBe(1);
		const row = await auditDb.auditEvent.findFirstOrThrow();
		expect(row.outcome).toBe("FAILURE");
		const serialized = JSON.stringify(row);
		// The argon2id marker every hash this module writes begins with, on the one path that has a
		// live hash in scope when it fails. See the note above: this states the shape a leak would take
		// rather than proving it cannot happen.
		expect(serialized).not.toContain("$argon2id$");
	});

	it("records an unexpected failure's fixed reason, never the exception's own message", async () => {
		// `unlockAccount`'s `perform` calls exactly one Prisma method, `user.update`. Stubbing it to
		// reject is the least invasive way to get a *raw*, un-authored exception out of a `perform` —
		// distinct from `resetPassword`'s "no credential" case, which is a `RecoveryRefusal` this
		// module wrote itself and was always going to be recorded safely.
		const user = await lockedOutUser("stub@example.test");
		const sentinel = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g";
		const updateSpy = vi.spyOn(prisma.user, "update").mockRejectedValueOnce(new Error(sentinel));

		try {
			await expect(unlockAccount(prisma, auditDb, "stub@example.test")).rejects.toThrow(sentinel);
		} finally {
			updateSpy.mockRestore();
		}

		const row = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.outcome).toBe("FAILURE");
		expect(row.action).toBe(RECOVERY_AUDIT_ACTIONS.UNLOCK);
		// The fixed reason recordFailure falls back to for anything that is not a RecoveryRefusal —
		// asserted as a literal rather than imported, since UNEXPECTED_FAILURE_REASON is intentionally
		// not exported: nothing outside this module needs to construct or compare against it.
		expect(row.detail).toBe(
			JSON.stringify({ reason: "an unexpected error; the exception is rethrown to the caller, never stored here" }),
		);
		expect(JSON.stringify(row)).not.toContain(sentinel);

		// The account itself is untouched: the stub prevented the real update from ever running.
		const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(after.lockedUntil).not.toBeNull();
	});

	it("leaves the chain verifiable after every operation, having written one row per operation", async () => {
		await credentialUser("chain@example.test", "old password entirely");
		await resetPassword(prisma, auditDb, "chain@example.test");
		await unlockAccount(prisma, auditDb, "chain@example.test");
		// `clearTwoFactor` is driven here rather than left to its own state-change case above, which
		// asserts only that the enrolment is gone. It was the one recovery operation nothing observed
		// writing a row. "Structural, so it cannot avoid the append" was the argument for leaving it —
		// and that was equally true of this whole test before it started counting rows, when it was
		// green against a module writing none at all.
		await clearTwoFactor(prisma, auditDb, "chain@example.test");
		await clearAllowlist(prisma, auditDb);

		const result = await verifyAuditChain(auditDb);
		expect(result.ok).toBe(true);

		// `ok` on its own is not enough, and saying so is the point of the two assertions below.
		// `verifyAuditChain` answers `{ ok: true, checked: 0 }` for an empty table — an intact chain of
		// nothing — so a version of this test that stopped at `ok` would stay green if all four
		// operations quietly stopped writing rows at all, which is the one regression a test named for
		// the audit trail most needs to catch.
		//
		// Four, not five: `credentialUser` writes its `User` and `Account` rows through Prisma
		// directly, the way a fixture does, and records nothing.
		expect(result.checked).toBe(4);
		expect(await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" }, select: { action: true } })).toEqual([
			{ action: RECOVERY_AUDIT_ACTIONS.RESET_PASSWORD },
			{ action: RECOVERY_AUDIT_ACTIONS.UNLOCK },
			{ action: RECOVERY_AUDIT_ACTIONS.CLEAR_TWO_FACTOR },
			{ action: RECOVERY_AUDIT_ACTIONS.CLEAR_ALLOWLIST },
		]);
	});
});
