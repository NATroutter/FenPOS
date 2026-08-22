import "server-only";
import { generateToken, hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * Administrator session lifecycle.
 *
 * Sessions are rows rather than self-contained signed cookies. That costs a lookup per
 * request and buys immediate revocation: signing out, or changing the password, invalidates
 * access at once instead of leaving a valid token in the wild until it expires. For a panel
 * that can pause printers and write raw bytes to hardware, that trade is the right way
 * round.
 *
 * Only the hash of a session token is stored, so a database disclosure does not hand an
 * attacker a usable session.
 *
 * This module deals only in tokens and rows. Reading and writing the cookie that carries the
 * token belongs to session-cookie.ts, which keeps the request-bound Next.js APIs out of the
 * lifecycle logic and lets that logic be tested directly.
 */

/**
 * How long a session remains valid after sign-in, in milliseconds.
 *
 * Reads `auth.sessionHours` (`settings-service.ts`) at the moment a session is created. The
 * expiry is stamped into the row then, not recomputed on every read, so shortening the setting
 * applies to sessions created afterwards and does not retroactively cut short one already
 * live — a session already in someone's browser keeps the lifetime it was issued until it is
 * explicitly revoked (sign-out, or a password change via {@link destroyAllSessions}).
 *
 * @returns the configured lifetime, in milliseconds
 */
async function sessionTtlMs(): Promise<number> {
	return (await integerSetting("auth.sessionHours")) * 3_600_000;
}

/**
 * Phrases the configured session lifetime for the note on the sign-in page footer, pluralising
 * "hour" only where the count requires it.
 *
 * Extracted for the same reason `signInThrottlePhrase` (`rate-limit.ts`) and
 * `minimumLengthPhrase` (`password-policy.ts`) were: this project has broken exactly this kind
 * of sentence at a boundary three times already — "0 MB", "1 distinct URLs", "1 hours" — and an
 * inline ternary at the one call site was the fourth chance to do it again, sitting right next
 * to the extracted version of the sentence beside it.
 *
 * @param hours the configured `auth.sessionHours`
 * @returns e.g. "12 hours" or, at a lifetime of one hour, "1 hour"
 */
export function sessionLifetimePhrase(hours: number): string {
	return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * How stale `lastSeenAt` may become before it is rewritten.
 *
 * Updating on every request would add a write to every page load for a field only used to
 * display activity. Reads `auth.lastSeenRefreshMinutes`, whose five-minute fallback keeps it
 * useful without the write amplification; an operator on a busier or quieter install can trade
 * accuracy against write volume either way.
 *
 * @returns the configured interval, in milliseconds
 */
async function lastSeenRefreshMs(): Promise<number> {
	return (await integerSetting("auth.lastSeenRefreshMinutes")) * 60_000;
}

/** An active session resolved from a request. */
export interface ActiveSession {
	id: string;
	expiresAt: Date;
}

/** Details recorded alongside a session, for display in the panel. */
export interface SessionOrigin {
	userAgent?: string | null;
	ipAddress?: string | null;
}

/**
 * Creates a session and returns its token.
 *
 * The plaintext token is returned exactly once, to be placed in the cookie; only its hash is
 * persisted, so it cannot be recovered afterwards.
 *
 * @param origin request details recorded for display
 * @param now current time; injectable for tests
 * @returns the plaintext token and the moment it expires
 */
export async function createSession(
	origin: SessionOrigin = {},
	now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
	const token = generateToken();
	const expiresAt = new Date(now.getTime() + (await sessionTtlMs()));

	await prisma.session.create({
		data: {
			tokenHash: hashSecret(token),
			createdAt: now,
			lastSeenAt: now,
			expiresAt,
			userAgent: origin.userAgent ?? null,
			ipAddress: origin.ipAddress ?? null,
		},
	});

	return { token, expiresAt };
}

/**
 * Resolves a session token to an active session.
 *
 * An expired row is deleted as it is found, so expiry is enforced on the read path and does
 * not depend on a sweep having run. Returns null for anything not currently valid — absent,
 * unknown, and expired are deliberately indistinguishable to the caller.
 *
 * @param token the plaintext token from the cookie
 * @param now current time; injectable for tests
 * @returns the active session, or null
 */
export async function resolveSession(token: string, now: Date = new Date()): Promise<ActiveSession | null> {
	if (!token) {
		return null;
	}

	const session = await prisma.session.findUnique({
		where: { tokenHash: hashSecret(token) },
		select: { id: true, expiresAt: true, lastSeenAt: true },
	});

	if (!session) {
		return null;
	}

	if (session.expiresAt <= now) {
		// Deleting here rather than only in a sweep means an expired session cannot be
		// resurrected by a clock change or a sweep that never ran.
		await prisma.session.delete({ where: { id: session.id } }).catch(() => {
			// Already gone, which is the state we wanted. A concurrent request deleting it
			// first is not a failure.
		});
		return null;
	}

	if (now.getTime() - session.lastSeenAt.getTime() > (await lastSeenRefreshMs())) {
		await prisma.session.update({
			where: { id: session.id },
			data: { lastSeenAt: now },
		});
	}

	return { id: session.id, expiresAt: session.expiresAt };
}

/**
 * Deletes one session.
 *
 * @param token the plaintext token to revoke
 */
export async function destroySession(token: string): Promise<void> {
	if (!token) {
		return;
	}
	await prisma.session.deleteMany({ where: { tokenHash: hashSecret(token) } });
}

/**
 * Deletes every session.
 *
 * Called when the administrator password changes: a password change must end sessions
 * elsewhere, otherwise it does not actually revoke access to whoever prompted the change.
 *
 * @returns how many sessions were ended
 */
export async function destroyAllSessions(): Promise<number> {
	const { count } = await prisma.session.deleteMany({});
	return count;
}

/**
 * Removes expired session rows.
 *
 * Expiry is already enforced on read, so this only reclaims space. Intended to run at
 * startup rather than on a timer, which keeps the server free of background work that would
 * need its own lifecycle management.
 *
 * @param now current time; injectable for tests
 * @returns how many rows were removed
 */
export async function purgeExpiredSessions(now: Date = new Date()): Promise<number> {
	const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lte: now } } });
	return count;
}
