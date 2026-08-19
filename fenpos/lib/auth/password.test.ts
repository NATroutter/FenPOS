import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashPassword, MINIMUM_PASSWORD_LENGTH, passwordSchema, verifyPassword } from "@/lib/auth/password";

const SERVER_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("passwordSchema", () => {
	it("accepts a password at the minimum length", () => {
		expect(passwordSchema.safeParse("a".repeat(MINIMUM_PASSWORD_LENGTH)).success).toBe(true);
	});

	it("rejects a password one character short", () => {
		expect(passwordSchema.safeParse("a".repeat(MINIMUM_PASSWORD_LENGTH - 1)).success).toBe(false);
	});

	it("rejects an absurdly long password rather than hashing it", () => {
		// Argon2 cost scales with input, so an unbounded password is a cheap way to make the
		// server do expensive work on every sign-in attempt.
		expect(passwordSchema.safeParse("a".repeat(1025)).success).toBe(false);
	});

	it("does not impose composition rules", () => {
		expect(passwordSchema.safeParse("correct horse battery staple").success).toBe(true);
	});

	it("accepts any character, including scripts, emoji, symbols and whitespace", () => {
		for (const password of [
			"日本語のパスワードですよ",
			"🔑🔑🔑🔑🔑🔑",
			"\t  leading and trailing  \n",
			"'; DROP TABLE admin_auth;--",
			"«»½¬{}[]|~`\\!@#$%^&*()",
		]) {
			expect(passwordSchema.safeParse(password).success, JSON.stringify(password)).toBe(true);
		}
	});

	it("measures length in UTF-16 units, so astral characters count double", () => {
		// Worth pinning because it is surprising: six emoji satisfy a twelve-character minimum
		// while five do not, and a twelve-letter Japanese phrase carries far more entropy than
		// a twelve-letter English one. The limit is a floor on effort, not on entropy.
		expect(passwordSchema.safeParse("🔑".repeat(6)).success).toBe(true);
		expect(passwordSchema.safeParse("🔑".repeat(5)).success).toBe(false);
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
	// scripts/set-admin-password.ts cannot import lib/auth/password.ts, because that module
	// is marked `server-only` and the script runs as plain Agent. It therefore duplicates the
	// argon2 parameters, and a silent divergence would mean the CLI writes hashes under
	// different settings than the application expects.
	const libSource = readFileSync(join(SERVER_ROOT, "lib/auth/password.ts"), "utf8");
	const scriptSource = readFileSync(join(SERVER_ROOT, "scripts/set-admin-password.ts"), "utf8");

	/**
	 * Extracts the argon2 options object literal from a source file.
	 *
	 * @param source file contents to search
	 * @returns the literal with whitespace collapsed, for comparison
	 */
	function argon2Options(source: string): string {
		const match = source.match(/const ARGON2_OPTIONS = \{([\s\S]*?)\} as const;/);
		if (!match) {
			throw new Error("ARGON2_OPTIONS literal not found");
		}
		return match[1].replace(/\s+/g, " ").trim();
	}

	/**
	 * Extracts the minimum password length declared in a source file.
	 *
	 * @param source file contents to search
	 * @returns the declared minimum
	 */
	function minimumLength(source: string): string {
		const match = source.match(/MINIMUM_PASSWORD_LENGTH = (\d+)/);
		if (!match) {
			throw new Error("MINIMUM_PASSWORD_LENGTH not found");
		}
		return match[1];
	}

	it("uses identical argon2 parameters in both places", () => {
		expect(argon2Options(scriptSource)).toBe(argon2Options(libSource));
	});

	it("uses an identical minimum password length in both places", () => {
		expect(minimumLength(scriptSource)).toBe(minimumLength(libSource));
		expect(minimumLength(libSource)).toBe(String(MINIMUM_PASSWORD_LENGTH));
	});

	it("uses an identical maximum password length in both places", () => {
		// The upper bound is what stops argon2 being handed a megabyte of input on every
		// attempt, so a CLI that did not share it would leave that door open.
		const libMaximum = libSource.match(/\.max\((\d+),/)?.[1];
		const scriptMaximum = scriptSource.match(/MAXIMUM_PASSWORD_LENGTH = (\d+)/)?.[1];

		expect(libMaximum).toBeDefined();
		expect(scriptMaximum).toBe(libMaximum);
	});
});

describe("what counts as the same password", () => {
	it("treats surrounding whitespace as part of the password", async () => {
		// No trimming anywhere on the path, so a password pasted with a stray space is a
		// different password. Stated in a test because the alternative — quietly trimming —
		// is the kind of helpfulness that turns into a lockout nobody can explain.
		const stored = await hashPassword("  padded password  ");

		expect(await verifyPassword(stored, "padded password")).toBe(false);
		expect(await verifyPassword(stored, "  padded password  ")).toBe(true);
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
