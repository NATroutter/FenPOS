import "server-only";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { globalPasswordLifetime } from "@/lib/settings/settings-service";

/**
 * What an account's previous passwords forbid, and when the current one runs out.
 *
 * Both features are off by default and this module is written for that: {@link recordPasswordChange}
 * always writes, {@link assertNotReused} reads the setting and usually does nothing. Writing history
 * regardless is the deliberate part — a history that only accumulated while the feature was on would
 * be empty for the first N changes after somebody enabled it, which is exactly when they expect it to
 * work.
 *
 * The stored rows are argon2 hashes, never plaintext and never a reversible digest. This table is
 * exactly as sensitive as `account.password` and is treated the same.
 */

/**
 * Records that an account's password changed.
 *
 * Called by every writer of a password: the forced reset, the self-service change, and an
 * administrator setting somebody else's. A writer that forgets this leaves the account's expiry clock
 * frozen and its history short by one, both silently — which is why it is one call rather than two
 * fields each caller has to remember.
 *
 * The history row and the timestamp go in one transaction. Separately, a crash between them leaves an
 * account whose history says it changed its password and whose expiry says it did not.
 *
 * @param userId the account whose password changed
 * @param passwordHash the PHC-format hash just stored
 * @param now the moment to stamp, injectable so tests need no sleeps
 */
export async function recordPasswordChange(
	userId: string,
	passwordHash: string,
	now: Date = new Date(),
): Promise<void> {
	await prisma.$transaction([
		prisma.passwordHistory.create({ data: { userId, passwordHash, createdAt: now } }),
		prisma.user.update({ where: { id: userId }, data: { passwordChangedAt: now } }),
	]);
}

/**
 * Refuses a password the account has used within the remembered window.
 *
 * Costs one argon2 verification per remembered password, which is why `auth.passwordReuseCount` has a
 * maximum of 24 rather than none: this runs on a request a person is waiting on, and argon2 is
 * expensive on purpose.
 *
 * @param userId the account changing its password
 * @param candidate the new password, as entered
 * @throws ApiError when it matches one the account has used
 */
export async function assertNotReused(userId: string, candidate: string): Promise<void> {
	const { reuseCount } = await globalPasswordLifetime();
	if (reuseCount === 0) {
		return;
	}

	const previous = await prisma.passwordHistory.findMany({
		where: { userId },
		orderBy: { createdAt: "desc" },
		take: reuseCount,
		select: { passwordHash: true },
	});

	for (const row of previous) {
		if (await verifyPassword(row.passwordHash, candidate)) {
			throw new ApiError(
				"invalid_type",
				reuseCount === 1
					? "That is the password already in use. Choose a different one."
					: `That is one of the last ${reuseCount} passwords on this account. Choose a different one.`,
			);
		}
	}
}

/**
 * Whether an account's password has outlived `auth.passwordExpiryDays`.
 *
 * **A null change date reads as not expired.** Every account created before that column existed has
 * one, and reading it as expired would force a password change across the whole install the moment
 * somebody turned the setting on — a self-inflicted outage rather than a security posture.
 *
 * @param user the account, needing only its change date
 * @param now current time; injectable so tests need no sleeps
 * @returns whether the account owes a password change
 */
export async function passwordExpired(
	user: { passwordChangedAt: Date | null },
	now: Date = new Date(),
): Promise<boolean> {
	const { expiryDays } = await globalPasswordLifetime();
	if (expiryDays === 0 || user.passwordChangedAt === null) {
		return false;
	}
	return now.getTime() - user.passwordChangedAt.getTime() > expiryDays * 24 * 60 * 60 * 1000;
}

/**
 * Whether the account behind a session owes a password change.
 *
 * The setting is read **before** the account is, and that ordering is the whole point: this runs in
 * `requireSession`, which every panel page and every server action goes through, and
 * `auth.passwordExpiryDays` is zero by default. Reading the account first would put a query on every
 * request of every install to answer a question that is almost always "no".
 *
 * @param userId the signed-in account
 * @param now current time; injectable so tests need no sleeps
 * @returns whether the account's password has outlived the configured lifetime
 */
export async function accountPasswordExpired(userId: string, now: Date = new Date()): Promise<boolean> {
	const { expiryDays } = await globalPasswordLifetime();
	if (expiryDays === 0) {
		return false;
	}

	const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordChangedAt: true } });
	if (!user) {
		return false;
	}
	return passwordExpired(user, now);
}

/**
 * Hashes a password and records the change in one step.
 *
 * The convenience the three writers share, so none of them can store one hash and record a different
 * one.
 *
 * @param userId the account whose password is being set
 * @param plaintext the new password, already validated
 * @returns the hash to store on the credential row
 */
export async function hashAndRecord(userId: string, plaintext: string): Promise<string> {
	const passwordHash = await hashPassword(plaintext);
	await recordPasswordChange(userId, passwordHash);
	return passwordHash;
}
