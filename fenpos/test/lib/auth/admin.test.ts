import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_DISPLAY_NAME,
	ensureAdminPassword,
	getAdminProfile,
	isAdminConfigured,
	isPasswordGenerated,
	setAdminPassword,
	setAdminProfile,
	verifyAdminPassword,
} from "@/lib/auth/admin";
import { passwordSchema } from "@/lib/auth/password";
import { MINIMUM_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { createSession, resolveSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

describe("administrator credential", () => {
	beforeEach(async () => {
		await prisma.session.deleteMany({});
		await prisma.adminAuth.deleteMany({});
	});

	it("reports an unconfigured install", async () => {
		await expect(isAdminConfigured()).resolves.toBe(false);
	});

	it("reports a configured install once bootstrapped", async () => {
		await setAdminPassword("correct horse battery staple");
		await expect(isAdminConfigured()).resolves.toBe(true);
	});

	it("verifies the password it was set to", async () => {
		await setAdminPassword("correct horse battery staple");
		await expect(verifyAdminPassword("correct horse battery staple")).resolves.toBe(true);
	});

	it("rejects the wrong password", async () => {
		await setAdminPassword("correct horse battery staple");
		await expect(verifyAdminPassword("incorrect horse battery staple")).resolves.toBe(false);
	});

	it("rejects any password when no administrator is configured", async () => {
		await expect(verifyAdminPassword("anything at all")).resolves.toBe(false);
	});

	it("stores a hash rather than the password", async () => {
		await setAdminPassword("correct horse battery staple");

		const row = await prisma.adminAuth.findFirst({ select: { passwordHash: true } });
		expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
		expect(row?.passwordHash).not.toContain("correct horse");
	});

	it("remains a singleton across repeated changes", async () => {
		await setAdminPassword("first password here");
		await setAdminPassword("second password here");

		expect(await prisma.adminAuth.count()).toBe(1);
		await expect(verifyAdminPassword("second password here")).resolves.toBe(true);
		await expect(verifyAdminPassword("first password here")).resolves.toBe(false);
	});

	it("ends every session when the password changes", async () => {
		await setAdminPassword("first password here");
		const session = await createSession();
		await expect(resolveSession(session.token)).resolves.not.toBeNull();

		const ended = await setAdminPassword("second password here");

		expect(ended).toBe(1);
		// A password change that left other sessions alive would revoke nothing, which is
		// usually the whole reason for changing it.
		await expect(resolveSession(session.token)).resolves.toBeNull();
	});

	describe("first-boot generation", () => {
		it("generates a password when none is configured", async () => {
			const generated = await ensureAdminPassword();

			expect(generated).not.toBeNull();
			await expect(isAdminConfigured()).resolves.toBe(true);
			// The value it reports must be the one that actually works, or the operator is
			// locked out of an install that looks configured.
			await expect(verifyAdminPassword(generated as string)).resolves.toBe(true);
		});

		it("marks a generated password as generated", async () => {
			await ensureAdminPassword();
			await expect(isPasswordGenerated()).resolves.toBe(true);
		});

		it("leaves an operator's password alone and reports nothing", async () => {
			await setAdminPassword("an operator chosen password");

			// A restart must not rotate the credential: it would lock out an operator who had
			// already set one, and print a password nobody asked for.
			await expect(ensureAdminPassword()).resolves.toBeNull();
			await expect(verifyAdminPassword("an operator chosen password")).resolves.toBe(true);
		});

		it("reports the same generated password on every start", async () => {
			const first = await ensureAdminPassword();
			const second = await ensureAdminPassword();

			// Reprinted on each boot for as long as it is in use, so an operator who missed the
			// first one can still get in — which only works if it is the same password.
			expect(second).toBe(first);
			await expect(verifyAdminPassword(first as string)).resolves.toBe(true);
		});

		it("forgets the generated password once an operator sets their own", async () => {
			await ensureAdminPassword();
			await setAdminPassword("an operator chosen password");

			// The plaintext is stored only so it can be reprinted. Once it is no longer the
			// credential, keeping it would be a readable password in the database for nothing.
			const row = await prisma.adminAuth.findUnique({ where: { id: 1 }, select: { generatedPassword: true } });
			expect(row?.generatedPassword).toBeNull();
			await expect(ensureAdminPassword()).resolves.toBeNull();
		});

		it("clears the generated mark once an operator sets their own", async () => {
			await ensureAdminPassword();
			await setAdminPassword("an operator chosen password");

			await expect(isPasswordGenerated()).resolves.toBe(false);
		});

		it("reports nothing generated on an unconfigured install", async () => {
			// Not yet bootstrapped is not the same as still on the generated password, and the
			// banner must not claim otherwise.
			await expect(isPasswordGenerated()).resolves.toBe(false);
		});

		it("generates a password long enough to satisfy the policy", async () => {
			const generated = await ensureAdminPassword();

			expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse(generated).success).toBe(true);
		});

		it("generates a different password each time", async () => {
			const first = await ensureAdminPassword();
			await prisma.adminAuth.deleteMany({});
			const second = await ensureAdminPassword();

			expect(first).not.toBe(second);
		});
	});
});

describe("administrator profile", () => {
	beforeEach(async () => {
		await prisma.session.deleteMany({});
		await prisma.adminAuth.deleteMany({});
	});

	/**
	 * A fresh install has no row at all until a password is set, and the sidebar renders on every
	 * page. Returning the default rather than null keeps a name in the footer at the one moment
	 * there is nothing to read.
	 */
	it("falls back to the default name when no administrator row exists", async () => {
		await expect(getAdminProfile()).resolves.toEqual({ displayName: DEFAULT_DISPLAY_NAME, email: null });
	});

	it("gives a newly bootstrapped install the default name and no email", async () => {
		await setAdminPassword("correct horse battery staple");

		await expect(getAdminProfile()).resolves.toEqual({ displayName: DEFAULT_DISPLAY_NAME, email: null });
	});

	it("stores and reads back a name and an email", async () => {
		await setAdminPassword("correct horse battery staple");
		await setAdminProfile({ displayName: "NATroutter", email: "me@natroutter.fi" });

		await expect(getAdminProfile()).resolves.toEqual({ displayName: "NATroutter", email: "me@natroutter.fi" });
	});

	it("stores an absent email as null rather than an empty string", async () => {
		await setAdminPassword("correct horse battery staple");
		await setAdminProfile({ displayName: "NATroutter", email: null });

		const row = await prisma.adminAuth.findFirst({ select: { email: true } });
		expect(row?.email).toBeNull();
	});

	/**
	 * The profile and the credential share one row. Writing the profile must not disturb the hash,
	 * and changing the password must not reset the name — the two are edited from different forms
	 * and neither should be a side effect of the other.
	 */
	it("leaves the password alone when the profile changes", async () => {
		await setAdminPassword("correct horse battery staple");
		await setAdminProfile({ displayName: "NATroutter", email: "me@natroutter.fi" });

		await expect(verifyAdminPassword("correct horse battery staple")).resolves.toBe(true);
	});

	it("leaves the profile alone when the password changes", async () => {
		await setAdminPassword("correct horse battery staple");
		await setAdminProfile({ displayName: "NATroutter", email: "me@natroutter.fi" });

		await setAdminPassword("a different passphrase entirely");

		await expect(getAdminProfile()).resolves.toEqual({ displayName: "NATroutter", email: "me@natroutter.fi" });
	});
});
