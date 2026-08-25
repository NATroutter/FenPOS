import "server-only";
import { createLocalAccountIssuer } from "better-auth";

/**
 * What an email-and-password credential looks like in the `account` table.
 *
 * Three writers now put one of these rows down — first-run setup, account creation, and setting
 * another account's password — and every one of them has to agree with what Better Auth's own
 * `findAccountByKey` looks for, because a row that disagrees does not fail loudly: it simply never
 * matches, and the account silently cannot sign in.
 *
 * `createLocalAccountIssuer` is Better Auth's own function for deriving the issuer, imported rather
 * than duplicated so this module cannot drift from whatever the library decides an issuer is.
 * `account-schema.test.ts` pins the result of that call end to end, by creating an account through
 * the library and signing in with it, so a library upgrade that changes the value fails a test here
 * instead of failing at somebody's sign-in.
 */

/** Better Auth's identifier for an email-and-password credential. */
export const CREDENTIAL_ISSUER = createLocalAccountIssuer("credential");

/**
 * The columns a credential account row carries.
 *
 * @param userId the account this credential belongs to
 * @param passwordHash a PHC-format argon2id string from `hashPassword`
 * @param now the timestamp to stamp both columns with, passed in so a caller writing several rows
 *   in one transaction can give them all one reading of the clock
 * @returns the `data` for a `prisma.account.create`
 */
export function credentialAccountRow(userId: string, passwordHash: string, now: Date) {
	return {
		id: crypto.randomUUID(),
		userId,
		issuer: CREDENTIAL_ISSUER,
		// Better Auth's identifier for an email-and-password credential. It looks these rows up by
		// this exact value, so it is not ours to choose.
		providerId: "credential",
		accountId: userId,
		password: passwordHash,
		createdAt: now,
		updatedAt: now,
	};
}
