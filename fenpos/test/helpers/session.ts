import { makeSignature } from "better-auth/crypto";
import { vi } from "vitest";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * A real signed-in session for tests that must drive `auth.api.*` methods that resolve their
 * caller from a cookie rather than from an argument.
 *
 * `next/headers` throws outside a live request, which is every test in this suite, so a caller
 * mocks it with `vi.mock("next/headers", () => ({ headers: () => headersMock() }));` of its own —
 * Vitest hoists a `vi.mock` call only within the file that literally writes it, so this module
 * cannot register that mock on a caller's behalf. What it *can* share is what `headers()` should
 * return: `signedInUser` and `refreshSession` below point this one `vi.fn` at a real session, so
 * every caller's mock factory reads the same answer — the trick `set-password/actions.test.ts` had
 * inline before this was pulled out, now shared so a second caller does not reinvent it.
 *
 * `auth` is loaded through `vi.importActual` inside the functions below rather than imported at
 * the top of this module. A caller that also mocks `@/lib/auth/auth` — `set-password/actions.test.ts`
 * stubs it down to the one method that test file cares about — would otherwise hand this helper
 * that same stub, which has no `createUser` or `signInEmail` to call.
 */
export const headersMock = vi.fn(async () => new Headers());

/**
 * Better Auth's cookie name for its own session token, under this install's default cookie prefix
 * (`advanced.cookiePrefix` is never set in `lib/auth/auth.ts`).
 */
const SESSION_COOKIE_NAME = "better-auth.session_token";

/**
 * Points the `headers()` mock at whatever session row Prisma currently holds for an account, by
 * signing that row's raw token with the same HMAC Better Auth's own cookie uses.
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
 * @param userId the account whose most recent session should now back `headers()`
 */
export async function refreshSession(userId: string): Promise<void> {
	const session = await prisma.session.findFirstOrThrow({
		where: { userId },
		orderBy: { createdAt: "desc" },
	});
	const signature = await makeSignature(session.token, env.BETTER_AUTH_SECRET);
	headersMock.mockResolvedValue(new Headers({ cookie: `${SESSION_COOKIE_NAME}=${session.token}.${signature}` }));
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
 * @param email the new account's address
 * @param password the new account's password
 * @returns the created user
 */
export async function signedInUser(email: string, password: string): Promise<{ user: SignedInAccount }> {
	const { auth } = await vi.importActual<typeof import("@/lib/auth/auth")>("@/lib/auth/auth");

	const created = await auth.api.createUser({ body: { email, password, name: email, role: "admin" } });
	await auth.api.signInEmail({ body: { email, password } });
	await refreshSession(created.user.id);

	return { user: created.user };
}
