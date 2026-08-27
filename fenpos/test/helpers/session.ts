import { makeSignature } from "better-auth/crypto";
import { vi } from "vitest";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * A real signed-in session for tests that must drive `auth.api.*` methods that resolve their
 * caller from a cookie rather than from an argument.
 *
 * `next/headers` throws outside a live request, which is every test in this suite, so a caller
 * mocks it with `vi.mock("next/headers", () => ({ headers: () => headersMock(), cookies: () =>
 * cookiesMock() }));` of its own — Vitest hoists a `vi.mock` call only within the file that
 * literally writes it, so this module cannot register that mock on a caller's behalf. What it *can*
 * share is what those two should return: `signedInUser` and `refreshSession` below point these
 * `vi.fn`s at a real session, so every caller's mock factory reads the same answer — the trick
 * `set-password/actions.test.ts` had inline before this was pulled out, now shared so a second
 * caller does not reinvent it.
 *
 * `auth` is loaded through `vi.importActual` inside the functions below rather than imported at
 * the top of this module. A caller that also mocks `@/lib/auth/auth` — `set-password/actions.test.ts`
 * stubs it down to the one method that test file cares about — would otherwise hand this helper
 * that same stub, which has no `createUser` or `signInEmail` to call.
 */
export const headersMock = vi.fn(async () => new Headers());

/** One entry of a cookie jar, in the shape both of Next's cookie-store types hand back. */
export interface CookiePair {
	name: string;
	value: string;
}

/** The one method `authHeaders` calls on Next's cookie store. */
export interface CookieStoreStub {
	getAll(): CookiePair[];
}

/**
 * Stands in for `cookies()`.
 *
 * `lib/auth/auth-headers.ts` reads the store through `getAll()` and nothing else, so that is all
 * this provides — a fuller stand-in would be inventing a contract no caller relies on. It is
 * separate from {@link headersMock} because production has to tell the two apart: after a server
 * action writes a cookie, Next keeps the store current and deliberately leaves the request's own
 * `Cookie` header alone, and that difference is the whole of the bug `authHeaders` exists to close.
 */
export const cookiesMock = vi.fn(async (): Promise<CookieStoreStub> => ({ getAll: () => [] }));

/**
 * A cookie store holding exactly the pairs given.
 *
 * @param pairs what `getAll()` should return
 * @returns the stand-in to hand {@link cookiesMock}
 */
export function cookieStoreOf(...pairs: CookiePair[]): CookieStoreStub {
	return { getAll: () => pairs };
}

/**
 * Better Auth's cookie name for its own session token, under this install's default cookie prefix
 * (`advanced.cookiePrefix` is never set in `lib/auth/auth.ts`).
 */
const SESSION_COOKIE_NAME = "better-auth.session_token";

/**
 * The cookie carrying an account's most recent session, signed the way Better Auth's own is.
 *
 * Exposed on its own so a test can point `headers()` and `cookies()` at *different* sessions, which
 * is what a request whose session was rotated mid-flight actually looks like.
 *
 * @param userId the account whose most recent session should be named
 * @returns the cookie's name and signed value
 */
export async function sessionCookieFor(userId: string): Promise<CookiePair> {
	const session = await prisma.session.findFirstOrThrow({
		where: { userId },
		orderBy: { createdAt: "desc" },
	});
	const signature = await makeSignature(session.token, env.BETTER_AUTH_SECRET);
	return { name: SESSION_COOKIE_NAME, value: `${session.token}.${signature}` };
}

/**
 * Points the `headers()` and `cookies()` mocks at whatever session row Prisma currently holds for
 * an account, by signing that row's raw token with the same HMAC Better Auth's own cookie uses.
 *
 * Reading the row directly, rather than driving another sign-in to get a fresh `Set-Cookie`, is
 * what makes this safe to call after *any* step that might have rotated the session out from under
 * a cookie already mocked — and the two-factor plugin does that on a verified `verifyTOTP` and on
 * `disableTwoFactor`, deleting the session the request arrived on and minting a new one. A second
 * `signInEmail` cannot stand in for this once TOTP is enabled: the account now stops that call at
 * the challenge it requires, rather than completing it. In a real browser none of this is visible —
 * Better Auth's `nextCookies` plugin writes the replacement `Set-Cookie` through Next's own cookie
 * store, and the browser sends the new one next time without anyone noticing — but there is no such
 * store in a test, so `headers()` has to be pointed at the current row by hand.
 *
 * @param userId the account whose most recent session should now back both `headers()` and `cookies()`
 */
export async function refreshSession(userId: string): Promise<void> {
	const pair = await sessionCookieFor(userId);
	headersMock.mockResolvedValue(new Headers({ cookie: `${pair.name}=${pair.value}` }));
	cookiesMock.mockResolvedValue(cookieStoreOf(pair));
}

/** The fields a test typically wants back after signing an account in. */
export interface SignedInAccount {
	id: string;
	name: string;
	email: string;
}

/**
 * Creates a real credential account, signs it in for real, and points the `headers()` mock at
 * that session.
 *
 * Goes through `auth.api.createUser` and `auth.api.signInEmail` rather than writing rows directly,
 * so the account has the exact shape Better Auth's own sign-in expects — a hashed password under
 * its own adapter, not one this test guessed the format of. The cookie itself, though, comes from
 * {@link refreshSession} reading the row the sign-in just created, rather than from the sign-in's
 * own response — one path for "point `headers()` at the current session" is one path to keep
 * correct, instead of two that must agree.
 *
 * **`role` defaults to `"user"`, which is what production defaults to** —
 * `account-service.ts:152` writes `role: "user"` for every panel-made account, and only
 * `setAccountSuperuser` ever writes `"admin"`. A caller needing an administrator asks for one.
 *
 * It defaulted to `"admin"` until this was flipped, and that default is how the `/set-password`
 * defect this phase found stayed hidden: every fixture account held the one role better-auth's admin
 * plugin treats specially, so a call gated on that plugin passed in the suite and refused in
 * production. A fixture whose default differs from production's cannot see that class of bug at all,
 * and the next admin-plugin-gated call added anywhere in the panel would have been hidden the same
 * way. The default now matches, so a test that genuinely needs an administrator has to say so — and
 * saying so is the thing that would have made the defect visible.
 *
 * @param email the new account's address
 * @param password the new account's password
 * @param role the account's better-auth role; `"admin"` only where the behaviour under test needs one
 * @returns the created user
 */
export async function signedInUser(
	email: string,
	password: string,
	role: "admin" | "user" = "user",
): Promise<{ user: SignedInAccount }> {
	const { auth } = await vi.importActual<typeof import("@/lib/auth/auth")>("@/lib/auth/auth");

	const created = await auth.api.createUser({ body: { email, password, name: email, role } });
	await auth.api.signInEmail({ body: { email, password } });
	await refreshSession(created.user.id);

	return { user: created.user };
}
