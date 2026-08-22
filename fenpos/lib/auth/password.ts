import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";
import { minimumLengthPhrase } from "@/lib/auth/password-policy";

/**
 * Administrator password hashing.
 *
 * This is the one credential in the system chosen by a human, so it is the one credential
 * with a brute-force surface worth defending: argon2id with a deliberately expensive memory
 * cost. Generated secrets — session tokens, agent tokens, API keys — are handled in
 * secrets.ts and hashed differently, for reasons documented there.
 */

/**
 * Argon2id, spelled as its numeric value.
 *
 * The library exports this as an ambient `const enum`, which `isolatedModules` forbids
 * referencing — the enum has no runtime representation to import. The literal is pinned here
 * instead, and the test asserting that hashes begin with `$argon2id$` is what stops a wrong
 * value going unnoticed.
 */
const ARGON2ID = 2;

/**
 * Argon2id parameters.
 *
 * 19 MiB at two iterations with one lane is the OWASP baseline. Memory cost is the parameter
 * that actually resists GPU attack, so it is preferred over raising iterations. These values
 * are recorded inside every hash string, so raising them later does not invalidate existing
 * hashes — an old hash keeps verifying under its own parameters until the password is next
 * changed.
 */
const ARGON2_OPTIONS = {
	algorithm: ARGON2ID,
	memoryCost: 19_456,
	timeCost: 2,
	parallelism: 1,
} as const;

/** Longest password accepted. Argon2's cost scales with input, so this is a work bound. */
export const MAXIMUM_PASSWORD_LENGTH = 1024;

/**
 * Characters that cannot survive being typed, pasted or stored intact.
 *
 * Tabs and newlines arrive by accident from a copied line; NUL and the rest of the C0/C1
 * ranges arrive from a mangled encoding. None can be reproduced reliably by a human at a
 * login form, so accepting one produces a password its owner cannot re-enter.
 */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * Normalises a password before it is hashed or compared.
 *
 * Only surrounding whitespace is removed, and it is removed on both the set and the verify
 * path so the two cannot disagree. A trailing space picked up by a double-click or a copied
 * line is invisible, and a credential that fails for a reason the operator cannot see is the
 * worst kind of lockout.
 *
 * Interior spaces are left alone deliberately — see `passwordSchema`.
 *
 * @param plaintext the password as entered
 * @returns the password as it should be hashed and compared
 */
export function normalizePassword(plaintext: string): string {
	return plaintext.trim();
}

/**
 * Builds the schema that validates a candidate administrator password.
 *
 * A function rather than a fixed schema, because `auth.minimumPasswordLength` is a stored
 * setting, read asynchronously — and this module is imported everywhere a password is checked,
 * including a `"use server"` action and a bare `tsx` script, so it cannot hold a database
 * connection open to fetch that setting itself. Every caller reads the minimum it cares about
 * first (the configured value where one is reachable, `MINIMUM_PASSWORD_LENGTH` where it is not —
 * see `password-policy.ts`) and builds its own schema from it; nothing here reads a stale minimum
 * while the setting appears to work, because nothing here reads the minimum at all.
 *
 * Length aside, there are no composition rules — requiring a digit, a symbol or mixed case
 * measurably pushes people toward predictable patterns without adding real entropy, and length is
 * the property that matters.
 *
 * **Interior spaces are allowed on purpose.** They are what makes a passphrase possible, and
 * `correct horse battery staple` is both far stronger and far more memorable than anything a
 * space ban leaves behind. Rejecting them is a habit inherited from systems that put
 * passwords into shell commands unquoted; nothing here does that, and the guidance that once
 * recommended it now says the opposite. What is worth removing is whitespace nobody can see,
 * which normalizePassword handles.
 *
 * @param minimumLength shortest password to accept, in characters
 * @returns a schema validating length, and control characters
 */
export function passwordSchema(minimumLength: number) {
	return z
		.string()
		.transform(normalizePassword)
		.pipe(
			z
				.string()
				.min(minimumLength, `Password must be at least ${minimumLengthPhrase(minimumLength)}.`)
				.max(MAXIMUM_PASSWORD_LENGTH, `Password must be at most ${MAXIMUM_PASSWORD_LENGTH} characters.`)
				.refine(
					(value) => !CONTROL_CHARACTERS.test(value),
					"Password must not contain tabs, newlines or control characters.",
				),
		);
}

/**
 * Hashes an administrator password for storage.
 *
 * @param plaintext the password as entered
 * @returns a PHC-format argon2id string carrying its own salt and parameters
 */
export async function hashPassword(plaintext: string): Promise<string> {
	return hash(normalizePassword(plaintext), ARGON2_OPTIONS);
}

/**
 * Verifies a password against a stored hash.
 *
 * A malformed or truncated hash returns false rather than throwing. A corrupted row must
 * read as "this password does not match" and fail the sign-in, never as a server error that
 * an attacker could use to distinguish a damaged installation from a wrong password.
 *
 * @param storedHash the PHC-format hash from the database
 * @param plaintext the password as entered
 * @returns whether the password matches
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
	try {
		// Normalised here as well as in hashPassword, so a password set through one path and
		// entered through another cannot disagree about its own surrounding whitespace.
		return await verify(storedHash, normalizePassword(plaintext), ARGON2_OPTIONS);
	} catch {
		return false;
	}
}
