import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginEnrolment, confirmEnrolment, endEnrolment } from "@/lib/auth/two-factor";
import { prisma } from "@/lib/db";
import { headersMock, refreshSession, signedInUser } from "@/test/helpers/session";

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

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decodes the plugin's stored base32 secret. */
function fromBase32(secret: string): Buffer {
	let bits = "";
	for (const character of secret.replace(/=+$/, "").toUpperCase()) {
		const index = BASE32.indexOf(character);
		if (index === -1) {
			throw new Error(`Not base32: ${character}`);
		}
		bits += index.toString(2).padStart(5, "0");
	}
	const bytes: number[] = [];
	for (let at = 0; at + 8 <= bits.length; at += 8) {
		bytes.push(Number.parseInt(bits.slice(at, at + 8), 2));
	}
	return Buffer.from(bytes);
}

/** RFC 6238, SHA-1, six digits, thirty-second step — the defaults every authenticator assumes. */
function totp(secret: string, at: number = Date.now()): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
	const digest = createHmac("sha1", fromBase32(secret)).update(counter).digest();
	const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
	const value = digest.readUInt32BE(offset) & 0x7fffffff;
	return (value % 1_000_000).toString().padStart(6, "0");
}

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
