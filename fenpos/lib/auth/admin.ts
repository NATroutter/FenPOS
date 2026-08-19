import "server-only";
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

/** Fixed primary key of the singleton row. */
const ADMIN_ROW_ID = 1;

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

	await prisma.adminAuth.upsert({
		where: { id: ADMIN_ROW_ID },
		create: { id: ADMIN_ROW_ID, passwordHash, isGenerated: false },
		update: { passwordHash, isGenerated: false },
	});

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
	if (await isAdminConfigured()) {
		return null;
	}

	const plaintext = generatePassword();
	const passwordHash = await hashPassword(plaintext);

	try {
		await prisma.adminAuth.create({
			data: { id: ADMIN_ROW_ID, passwordHash, isGenerated: true },
		});
	} catch {
		// Another process won the race between the check and the insert. Theirs is as good as
		// this one, and reporting a password that is not in effect would be worse than silence.
		return null;
	}

	return plaintext;
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
