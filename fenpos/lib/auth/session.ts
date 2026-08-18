import "server-only";
import { generateToken, hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

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

/** How long a session remains valid after sign-in. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How stale `lastSeenAt` may become before it is rewritten.
 *
 * Updating on every request would add a write to every page load for a field only used to
 * display activity. Five minutes keeps it useful without the write amplification.
 */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

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
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

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

	if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
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
