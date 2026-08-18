import "server-only";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { generateToken } from "@/lib/auth/secrets";
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
 * The credential is bootstrapped from the command line rather than through a first-run web
 * page. An unauthenticated setup route is a takeover waiting to happen on a server that is
 * reachable before anyone configures it; requiring shell access to set the first password
 * removes that window entirely.
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
		create: { id: ADMIN_ROW_ID, passwordHash },
		update: { passwordHash },
	});

	return destroyAllSessions();
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
