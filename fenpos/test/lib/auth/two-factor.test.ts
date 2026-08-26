import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginEnrolment, confirmEnrolment, endEnrolment } from "@/lib/auth/two-factor";
import { prisma } from "@/lib/db";
import { headersMock, refreshSession, signedInUser } from "@/test/helpers/session";
import { totp } from "@/test/helpers/totp";

// `@/lib/auth/two-factor` imports `next/headers` itself, so this must be a real `vi.mock` call —
// written here, not merely re-exported from the helper — for Vitest to hoist it above that import.
vi.mock("next/headers", () => ({ headers: () => headersMock() }));

/**
 * Enrolment end to end, against the real plugin and a real code.
 *
 * The code is computed here rather than mocked. A test that stubbed the verification would pass
 * against a broken secret, an unshared clock, or a digit count nobody's phone agrees with — which
 * is the entire class of defect this feature can have.
 */

describe("two-factor enrolment", () => {
	beforeEach(async () => {
		await prisma.twoFactor.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	it("hands back a URI, a QR and recovery codes without enabling anything yet", async () => {
		const { user } = await signedInUser("enrol@example.test", "correct horse battery staple");
		const enrolment = await beginEnrolment("correct horse battery staple");

		expect(enrolment.totpUri.startsWith("otpauth://totp/")).toBe(true);
		expect(enrolment.qrSvg.startsWith("<svg")).toBe(true);
		expect(enrolment.recoveryCodes.length).toBeGreaterThan(0);

		const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(Boolean(row.twoFactorEnabled)).toBe(false);
	});

	it("enables the account once a real code is verified", async () => {
		const { user } = await signedInUser("confirm@example.test", "correct horse battery staple");
		const enrolment = await beginEnrolment("correct horse battery staple");
		const secret = new URL(enrolment.totpUri).searchParams.get("secret") ?? "";

		await confirmEnrolment(totp(secret));

		const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(Boolean(row.twoFactorEnabled)).toBe(true);
	});

	it("refuses a wrong code and leaves the account un-enrolled", async () => {
		const { user } = await signedInUser("wrong@example.test", "correct horse battery staple");
		await beginEnrolment("correct horse battery staple");

		await expect(confirmEnrolment("000000")).rejects.toThrow();

		const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(Boolean(row.twoFactorEnabled)).toBe(false);
	});

	it("refuses to begin without the account's password", async () => {
		await signedInUser("nopass@example.test", "correct horse battery staple");
		await expect(beginEnrolment("not the password")).rejects.toThrow();
	});

	/**
	 * The plugin does not treat a second `enableTwoFactor` as a no-op: it replaces an already-verified
	 * enrolment's secret and codes in place, `verified: true`, live, with no confirmation step. A
	 * stale tab still showing the "set up" screen could otherwise mint a fresh secret that takes
	 * effect at once and silently strand the operator's already-working authenticator.
	 */
	it("refuses to re-enrol an account that already has a verified authenticator", async () => {
		const { user } = await signedInUser("already@example.test", "correct horse battery staple");
		const enrolment = await beginEnrolment("correct horse battery staple");
		const secret = new URL(enrolment.totpUri).searchParams.get("secret") ?? "";
		await confirmEnrolment(totp(secret));
		// `confirmEnrolment` just rotated the session — see `refreshSession`'s doc comment.
		await refreshSession(user.id);

		await expect(beginEnrolment("correct horse battery staple")).rejects.toThrow(/already/i);

		// The refused attempt must not have disturbed the working enrolment.
		const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(Boolean(row.twoFactorEnabled)).toBe(true);
	});

	it("clears the enrolment and its rows on the way out", async () => {
		const { user } = await signedInUser("off@example.test", "correct horse battery staple");
		const enrolment = await beginEnrolment("correct horse battery staple");
		const secret = new URL(enrolment.totpUri).searchParams.get("secret") ?? "";
		await confirmEnrolment(totp(secret));
		// `confirmEnrolment` just rotated the session — see `refreshSession`'s doc comment — so the
		// cookie this test signed in with no longer resolves to any session at all.
		await refreshSession(user.id);

		await endEnrolment("correct horse battery staple");

		const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
		expect(Boolean(row.twoFactorEnabled)).toBe(false);
		expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(0);
	});
});
