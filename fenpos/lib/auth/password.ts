import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";

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

/** Shortest password accepted. Matches the minimum stated in the admin panel. */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Validates a candidate administrator password.
 *
 * Only length is enforced. Composition rules (a digit, a symbol, mixed case) are omitted
 * deliberately: they measurably push people toward predictable patterns without adding real
 * entropy, and length is the property that matters.
 */
export const passwordSchema = z
	.string()
	.min(MINIMUM_PASSWORD_LENGTH, `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`)
	.max(1024, "Password must be at most 1024 characters.");

/**
 * Hashes an administrator password for storage.
 *
 * @param plaintext the password as entered
 * @returns a PHC-format argon2id string carrying its own salt and parameters
 */
export async function hashPassword(plaintext: string): Promise<string> {
	return hash(plaintext, ARGON2_OPTIONS);
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
		return await verify(storedHash, plaintext, ARGON2_OPTIONS);
	} catch {
		return false;
	}
}
