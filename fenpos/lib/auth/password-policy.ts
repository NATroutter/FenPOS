/**
 * Password-length rules shared by both sides of the wire.
 *
 * Deliberately a plain module: no `server-only`, no `node:` imports, nothing that reaches the
 * database or argon2's native binding. `password.ts` validates against these, and the profile
 * dialog and the initial-password hint quote them — the same reason `profile.ts` beside this file
 * is plain — so this has to be importable from a client component without pulling
 * `@node-rs/argon2` into the browser bundle along with it.
 */

/**
 * The floor `auth.minimumPasswordLength` can never fall below, and what the standalone recovery
 * scripts enforce.
 *
 * The scripts (`scripts/set-admin-password.ts`, `scripts/reset-admin-password.ts`) run as one-shot
 * `tsx` processes outside the running server, with their own ad hoc Prisma connection — they never
 * reach `settings-service.ts` and so never see an administrator-raised minimum. That is an accepted
 * gap rather than an oversight: they are a break-glass recovery path, and this floor is still a
 * real one, never the silent zero a missing check would leave behind.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Phrases a password-length minimum for a sentence, pluralising "character" only where the count
 * requires it.
 *
 * Extracted because this project has broken exactly this kind of sentence at a boundary three
 * times already — "0 MB", "1 distinct URLs", "1 hours" — and `auth.minimumPasswordLength`'s own
 * hints are one more chance to do it a fourth time. `password.ts`'s validation message and every
 * "At least N characters" hint in the panel share this one function instead of each spelling out
 * their own plural.
 *
 * @param length the minimum to phrase, in characters
 * @returns the count with the correctly pluralised unit, e.g. "12 characters" or "1 character"
 */
export function minimumLengthPhrase(length: number): string {
	return `${length} ${length === 1 ? "character" : "characters"}`;
}
