import "server-only";
import { ADMIN_ROW_ID, writeOperatorPassword } from "@/lib/auth/admin-credential";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { generatePassword, generateToken } from "@/lib/auth/secrets";
import { destroyAllSessions } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

/**
 * The single administrator credential.
 *
 * There is one administrator per install and no user table: the panel is an operations
 * console for one business, and inventing accounts and roles for it would add a permission
 * model with no one to apply it to. Machine clients authenticate with API keys instead,
 * which is where granular authority actually belongs.
 *
 * The credential is bootstrapped by the server itself: on first boot it generates a random
 * password, stores the hash, and prints the plaintext once to the startup log. An
 * unauthenticated setup page would be a takeover waiting to happen on a server reachable
 * before anyone configures it, and a fixed default such as "admin" is the same hole with a
 * published key. A generated secret closes it while still requiring nothing of the operator
 * beyond reading the log they just started.
 *
 * The generated password is marked as such, so the panel can insist on its replacement and
 * confirm when that has happened.
 */

/**
 * Cached argon2 hash of a value no one holds, used to equalise timing.
 *
 * Computed on demand rather than written as a literal, because a hand-written PHC string
 * that argon2 rejects would throw, return early, and reintroduce exactly the timing
 * difference this exists to remove.
 */
let timingEqualiserHash: Promise<string> | null = null;

/**
 * Returns a valid argon2 hash to verify against when no administrator exists.
 *
 * When no administrator is configured, verification still performs a real argon2 comparison.
 * Returning early instead would make an unconfigured install answer measurably faster than a
 * configured one, disclosing whether bootstrapping has happened yet.
 *
 * @returns a hash of an unguessable random value, computed once per process
 */
function getTimingEqualiserHash(): Promise<string> {
	timingEqualiserHash ??= hashPassword(generateToken());
	return timingEqualiserHash;
}

/**
 * Whether an administrator password has been set.
 *
 * @returns true once the install has been bootstrapped
 */
export async function isAdminConfigured(): Promise<boolean> {
	const row = await prisma.adminAuth.findUnique({
		where: { id: ADMIN_ROW_ID },
		select: { id: true },
	});
	return row !== null;
}

/**
 * Sets or replaces the administrator password.
 *
 * Every existing session is destroyed as part of the change. A password change that left
 * other sessions alive would not actually revoke anything, which is usually the entire
 * reason for changing it.
 *
 * @param plaintext the new password, already validated against `passwordSchema`
 * @returns how many sessions were ended by the change
 */
export async function setAdminPassword(plaintext: string): Promise<number> {
	const passwordHash = await hashPassword(plaintext);

	// Shared with the CLI scripts, which cannot import this module. Clearing the generated
	// plaintext is the point at which the bootstrap credential stops existing anywhere
	// recoverable, and it happens in the same statement as the new hash.
	await writeOperatorPassword(prisma, passwordHash);

	return destroyAllSessions();
}

/**
 * Whether the install is still using the password generated at first boot.
 *
 * @returns true while the generated password has never been replaced
 */
export async function isPasswordGenerated(): Promise<boolean> {
	const row = await prisma.adminAuth.findUnique({
		where: { id: ADMIN_ROW_ID },
		select: { isGenerated: true },
	});
	return row?.isGenerated ?? false;
}

/**
 * Creates the administrator credential on first boot.
 *
 * Does nothing once a credential exists, so a restart never invalidates the operator's
 * password or prints a stale one. The plaintext is returned rather than logged here, leaving
 * the caller to decide how it is surfaced — this module should not assume a console exists.
 *
 * @returns the generated password on the boot that created it, or null when one was already set
 */
export async function ensureAdminPassword(): Promise<string | null> {
	const existing = await prisma.adminAuth.findUnique({
		where: { id: ADMIN_ROW_ID },
		select: { isGenerated: true, generatedPassword: true },
	});

	if (existing) {
		// Still on the generated password: hand back the same one rather than a new one. An
		// operator who missed the first boot's output, or who restarted before signing in,
		// needs the credential that actually works — rotating it on every start would make
		// anything they wrote down wrong.
		return existing.isGenerated ? existing.generatedPassword : null;
	}

	const plaintext = generatePassword();
	const passwordHash = await hashPassword(plaintext);

	try {
		await prisma.adminAuth.create({
			data: { id: ADMIN_ROW_ID, passwordHash, isGenerated: true, generatedPassword: plaintext },
		});
	} catch {
		// Another process won the race between the check and the insert. Theirs is as good as
		// this one, and reporting a password that is not in effect would be worse than silence.
		return null;
	}

	return plaintext;
}

/**
 * The name a row carries before anyone changes it.
 *
 * Duplicated as `@default` on the column, which is what migrates the existing row; this constant
 * is what answers for an install that has no row at all. The two must agree, and there is no way
 * to derive one from the other, so they are stated together here.
 */
export const DEFAULT_DISPLAY_NAME = "Administrator";

/** The administrator's identity, as the sidebar and the profile dialog need it. */
export interface AdminProfile {
	displayName: string;
	email: string | null;
}

/**
 * Reads the administrator's identity.
 *
 * Falls back to the default rather than failing when no row exists: this is read by the panel
 * layout, so it runs on every page, including the window between an install starting and a
 * password being set.
 *
 * @returns the name and email
 */
export async function getAdminProfile(): Promise<AdminProfile> {
	const row = await prisma.adminAuth.findUnique({
		where: { id: ADMIN_ROW_ID },
		select: { displayName: true, email: true },
	});

	return { displayName: row?.displayName ?? DEFAULT_DISPLAY_NAME, email: row?.email ?? null };
}

/**
 * Replaces the administrator's identity.
 *
 * Deliberately touches only these two columns: the password hash lives in the same row and is
 * changed from a different form, for a different reason, with a different check in front of it.
 *
 * @param profile the name and email to store, already validated
 */
export async function setAdminProfile(profile: AdminProfile): Promise<void> {
	await prisma.adminAuth.update({
		where: { id: ADMIN_ROW_ID },
		data: { displayName: profile.displayName, email: profile.email },
	});
}

/**
 * Verifies a candidate administrator password.
 *
 * Takes comparable time whether or not an administrator is configured, so the response does
 * not disclose the install's bootstrap state.
 *
 * @param plaintext the password as entered
 * @returns whether it matches the stored credential
 */
export async function verifyAdminPassword(plaintext: string): Promise<boolean> {
	const row = await prisma.adminAuth.findUnique({
		where: { id: ADMIN_ROW_ID },
		select: { passwordHash: true },
	});

	if (!row) {
		await verifyPassword(await getTimingEqualiserHash(), plaintext);
		return false;
	}

	return verifyPassword(row.passwordHash, plaintext);
}
