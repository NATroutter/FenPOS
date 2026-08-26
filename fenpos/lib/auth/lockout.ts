import "server-only";
import { prisma } from "@/lib/db";
import { globalSignInPolicy } from "@/lib/settings/settings-service";

/**
 * Locking an account after consecutive failed sign-ins.
 *
 * **A second mechanism, not a replacement for the address throttle.** `auth.signInAttemptsPerMinute`
 * keys on the client address: it defends the server against grinding, and it resets on success. This
 * keys on the account and persists across addresses, because an attacker with more than one address
 * defeats an address limiter entirely while still having only one password to guess.
 *
 * **Off by default.** An account lockout is a denial-of-service primitive handed to anybody who knows
 * an email address — they cannot get in, but they can keep the operator out, and on a till system
 * "the manager cannot sign in during the lunch rush" is a real outage. An install that wants it turns
 * it on and accepts that trade.
 *
 * **Keyed by email, and silent about unknown ones.** The sign-in path has an address and not yet an
 * account. An address matching no account records nothing and reports no lock, exactly as a known one
 * under its threshold does — otherwise the endpoint becomes a way to ask which addresses hold
 * accounts, which is the one thing the sign-in path's uniform rejection message exists to refuse.
 */

/**
 * How much longer an account stays locked.
 *
 * @param email the address as submitted; normalised here
 * @param now current time; injectable so tests need no sleeps
 * @returns milliseconds remaining, or 0 when not locked
 */
export async function lockedOutFor(email: string, now: Date = new Date()): Promise<number> {
	const user = await prisma.user.findFirst({
		where: { email: email.trim().toLowerCase() },
		select: { lockedUntil: true },
	});

	if (!user?.lockedUntil) {
		return 0;
	}
	return Math.max(0, user.lockedUntil.getTime() - now.getTime());
}

/**
 * Counts one failure against an account, locking it at the threshold.
 *
 * @param email the address as submitted; normalised here
 * @param now current time; injectable so tests need no sleeps
 */
export async function recordFailedSignIn(email: string, now: Date = new Date()): Promise<void> {
	const { lockoutAfterFailures, lockoutMinutes } = await globalSignInPolicy();
	if (lockoutAfterFailures === 0) {
		return;
	}

	const user = await prisma.user.findFirst({
		where: { email: email.trim().toLowerCase() },
		select: { id: true, failedSignInCount: true },
	});
	if (!user) {
		return;
	}

	const failures = user.failedSignInCount + 1;
	await prisma.user.update({
		where: { id: user.id },
		data: {
			failedSignInCount: failures,
			// Set at the threshold and at every failure past it, so an attacker who keeps guessing
			// keeps the lock fresh rather than waiting it out while still trying. Only a successful
			// sign-in clears the count, through `clearFailedSignIns`.
			...(failures >= lockoutAfterFailures
				? { lockedUntil: new Date(now.getTime() + lockoutMinutes * 60 * 1000) }
				: {}),
		},
	});
}

/**
 * Forgets an account's failures. Called on every successful sign-in.
 *
 * @param userId the account that just signed in
 */
export async function clearFailedSignIns(userId: string): Promise<void> {
	await prisma.user.update({ where: { id: userId }, data: { failedSignInCount: 0, lockedUntil: null } });
}
