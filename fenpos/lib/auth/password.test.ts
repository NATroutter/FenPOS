import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/auth/password";
import { MINIMUM_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { prisma } from "@/lib/db";
import { integerSetting, setSetting } from "@/lib/settings/settings-service";

const SERVER_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * `passwordSchema` takes the minimum as a parameter rather than baking one in — see its doc
 * comment in `password.ts` for why. These tests build it with `MINIMUM_PASSWORD_LENGTH`, the
 * built-in floor, throughout; the block below confirms a caller that reads the configured
 * `auth.minimumPasswordLength` instead gets a schema that actually enforces it.
 */
describe("passwordSchema", () => {
	it("accepts a password at the minimum length", () => {
		expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse("a".repeat(MINIMUM_PASSWORD_LENGTH)).success).toBe(true);
	});

	it("rejects a password one character short", () => {
		expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse("a".repeat(MINIMUM_PASSWORD_LENGTH - 1)).success).toBe(
			false,
		);
	});

	it("rejects an absurdly long password rather than hashing it", () => {
		// Argon2 cost scales with input, so an unbounded password is a cheap way to make the
		// server do expensive work on every sign-in attempt.
		expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse("a".repeat(1025)).success).toBe(false);
	});

	it("does not impose composition rules", () => {
		expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse("correct horse battery staple").success).toBe(true);
	});

	it("accepts any printable character, including other scripts, emoji and symbols", () => {
		for (const password of [
			"日本語のパスワードですよ",
			"🔑🔑🔑🔑🔑🔑",
			"'; DROP TABLE admin_auth;--",
			"«»½¬{}[]|~`\\!@#$%^&*()",
		]) {
			expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse(password).success, JSON.stringify(password)).toBe(true);
		}
	});

	it("allows interior spaces, because passphrases are the point", () => {
		expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse("correct horse battery staple").success).toBe(true);
	});

	it("rejects control characters", () => {
		// A tab or newline arrives from a copied line and cannot be retyped at a login form,
		// so accepting one sets a password its owner cannot enter again.
		for (const password of ["twelve chars\there", "twelve chars\nhere", "twelve chars\0here"]) {
			expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse(password).success, JSON.stringify(password)).toBe(false);
		}
	});

	it("measures length in UTF-16 units, so astral characters count double", () => {
		// Worth pinning because it is surprising: six emoji satisfy a twelve-character minimum
		// while five do not, and a twelve-letter Japanese phrase carries far more entropy than
		// a twelve-letter English one. The limit is a floor on effort, not on entropy.
		expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse("🔑".repeat(6)).success).toBe(true);
		expect(passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse("🔑".repeat(5)).success).toBe(false);
	});
});

/**
 * `auth.minimumPasswordLength` — the setting that makes the minimum above configurable. What is
 * worth pinning down is that a caller reading the *configured* value gets a schema that actually
 * enforces it, not that the setting stores: `settings-service.test.ts` already covers storage,
 * and the floor itself (never lower than the built-in `MINIMUM_PASSWORD_LENGTH`) is pinned down
 * there too, as a `setSetting` rejection.
 */
describe("passwordSchema with a configured minimum", () => {
	it("enforces the configured minimum rather than the built-in floor", async () => {
		await prisma.setting.deleteMany();
		await setSetting("auth.minimumPasswordLength", 20);

		const configuredMinimum = await integerSetting("auth.minimumPasswordLength");

		expect(passwordSchema(configuredMinimum).safeParse("a".repeat(16)).success).toBe(false);
		expect(passwordSchema(configuredMinimum).safeParse("a".repeat(20)).success).toBe(true);
	});
});

describe("hashPassword and verifyPassword", () => {
	it("verifies a correct password", async () => {
		const hash = await hashPassword("correct horse battery staple");
		await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
	});

	it("rejects an incorrect password", async () => {
		const hash = await hashPassword("correct horse battery staple");
		await expect(verifyPassword(hash, "correct horse battery stapl")).resolves.toBe(false);
	});

	it("salts, so the same password hashes differently each time", async () => {
		const [first, second] = await Promise.all([hashPassword("same-password-xyz"), hashPassword("same-password-xyz")]);
		expect(first).not.toBe(second);
	});

	it("produces an argon2id hash", async () => {
		expect(await hashPassword("another-password")).toMatch(/^\$argon2id\$/);
	});

	it("returns false rather than throwing on a malformed stored hash", async () => {
		// A corrupted row must read as a failed sign-in, not as a server error that
		// distinguishes a damaged install from a wrong password.
		await expect(verifyPassword("not-a-hash", "whatever")).resolves.toBe(false);
		await expect(verifyPassword("", "whatever")).resolves.toBe(false);
		await expect(verifyPassword("$argon2id$v=19$truncated", "whatever")).resolves.toBe(false);
	});
});

describe("bootstrap script parity", () => {
	const scriptSources = ["scripts/set-admin-password.ts", "scripts/reset-admin-password.ts"].map((path) =>
		readFileSync(join(SERVER_ROOT, path), "utf8"),
	);

	it("leaves hashing, validation and the row shape to the shared modules", () => {
		// These were once copied into the scripts, on the belief that all of lib/auth was
		// server-only. They drifted, and the CLI ended up writing a password while the server
		// went on advertising the generated one it had replaced. A copy reappearing is the
		// failure this guards, so the test is that the constants are absent rather than equal.
		for (const source of scriptSources) {
			expect(source).not.toMatch(/ARGON2_OPTIONS\s*=\s*\{/);
			expect(source).not.toMatch(/MINIMUM_PASSWORD_LENGTH\s*=\s*\d/);
			expect(source).not.toMatch(/MAXIMUM_PASSWORD_LENGTH\s*=\s*\d/);
			expect(source).not.toMatch(/ADMIN_ROW_ID\s*=\s*\d/);
		}
	});

	it("imports them from lib/auth instead", () => {
		expect(scriptSources[0]).toMatch(/from "\.\.\/lib\/auth\/password"/);
		for (const source of scriptSources) {
			expect(source).toMatch(/from "\.\.\/lib\/auth\/admin-credential"/);
		}
	});
});

describe("what counts as the same password", () => {
	it("ignores surrounding whitespace on both the set and the entry path", async () => {
		// Trimmed at both ends of the journey, so a trailing space from a double-click or a
		// copied line cannot make a correct password fail for a reason nobody can see.
		const stored = await hashPassword("  padded password  ");

		expect(await verifyPassword(stored, "padded password")).toBe(true);
		expect(await verifyPassword(stored, "  padded password  ")).toBe(true);
		expect(await verifyPassword(stored, "padded  password")).toBe(false);
	});

	it("counts length after trimming, so padding cannot pad out the minimum", async () => {
		expect(
			passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse(`   ${"a".repeat(MINIMUM_PASSWORD_LENGTH - 1)}   `).success,
		).toBe(false);
	});

	it("does not normalise unicode, so composed and decomposed forms differ", async () => {
		// Two keyboards can produce visually identical text with different code points. Argon2
		// hashes bytes, so they will not match. Normalising would be friendlier but changes the
		// bytes hashed, which would invalidate every existing password on the release that did it.
		const composed = "café latte!!";
		const stored = await hashPassword(composed);

		expect(await verifyPassword(stored, composed.normalize("NFD"))).toBe(false);
		expect(await verifyPassword(stored, composed)).toBe(true);
	});
});
