import "server-only";
import { cookies } from "next/headers";
import { type ActiveSession, resolveSession } from "@/lib/auth/session";
import { isProduction } from "@/lib/env";

/**
 * Reading and writing the cookie that carries the session token.
 *
 * Separated from session.ts so that the session lifecycle — creation, expiry, revocation —
 * does not depend on Next.js request-scoped APIs. That keeps the security-critical logic
 * testable directly, and confines the request binding to this small adapter.
 */

/** Cookie carrying the session token. */
export const SESSION_COOKIE = "fenpos_session";

/**
 * Cookie attributes for the session.
 *
 * `Secure` is omitted outside production because local development is served over plain
 * HTTP, where the browser would discard a Secure cookie and make sign-in appear broken.
 * `SameSite=Lax` stops the cookie riding along with cross-site form posts, which is the CSRF
 * vector that matters for a panel whose own actions are all same-origin.
 *
 * @param expiresAt when the cookie should stop being sent
 * @returns attributes to apply when writing the cookie
 */
function sessionCookieOptions(expiresAt: Date) {
	return {
		httpOnly: true,
		secure: isProduction,
		sameSite: "lax",
		path: "/",
		expires: expiresAt,
	} as const;
}

/**
 * Writes the session cookie on the outgoing response.
 *
 * @param token the plaintext session token
 * @param expiresAt when the session expires
 */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
	const store = await cookies();
	store.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

/**
 * Clears the session cookie on the outgoing response.
 *
 * Both an expiry in the past and a zero max-age are set, because browsers disagree about
 * which one they honour when the two are present.
 */
export async function clearSessionCookie(): Promise<void> {
	const store = await cookies();
	store.set(SESSION_COOKIE, "", { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
}

/**
 * Reads the session token from the incoming request.
 *
 * @returns the token, or null when the cookie is absent
 */
export async function readSessionCookie(): Promise<string | null> {
	const store = await cookies();
	return store.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Resolves the current request's session.
 *
 * @returns the active session, or null when the request is unauthenticated
 */
export async function getCurrentSession(): Promise<ActiveSession | null> {
	const token = await readSessionCookie();
	return token ? resolveSession(token) : null;
}
