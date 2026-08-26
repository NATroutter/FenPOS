import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cookieStoreOf,
	cookiesMock,
	headersMock,
	refreshSession,
	sessionCookieFor,
	signedInUser,
} from "@/test/helpers/session";
import { totp } from "@/test/helpers/totp";

/**
 * The session gate, on a request that replaced its own session cookie part-way through.
 *
 * Better Auth's two-factor plugin rotates the session on a verified `verifyTOTP` and on
 * `disableTwoFactor`: it deletes the row the request arrived on, issues a new one, and writes the
 * replacement cookie through `nextCookies()` into Next's cookie store. The request's own `Cookie`
 * header is not rewritten — Next keeps the cookie store current across the action/render boundary
 * and says in its own source that headers are not given the same treatment.
 *
 * That gap is what these tests pin down. `headers()` is deliberately left naming the session the
 * rotation deleted while `cookies()` names the one it issued, which is exactly the state the panel
 * layout is rendered in once a two-factor action returns. Before `authHeaders`, `requireSession`
 * read the stale header, found nothing, and redirected the whole panel to `/login` — which is what
 * made the profile dialog vanish, taking the only display of the recovery codes with it.
 */

const redirected = vi.fn((destination: string) => {
	throw new Error(`REDIRECT:${destination}`);
});

vi.mock("next/navigation", () => ({ redirect: redirected }));
vi.mock("next/headers", () => ({ headers: () => headersMock(), cookies: () => cookiesMock() }));

const { beginEnrolment, confirmEnrolment, endEnrolment } = await import("@/lib/auth/two-factor");
const { currentUser, requireSession } = await import("@/lib/auth/require-session");
const { prisma } = await import("@/lib/db");

const PASSWORD = "correct horse battery staple";

/**
 * Puts the request in the state Next leaves it in after a server action wrote a cookie: the store
 * names the account's current session, the `Cookie` header still names whatever it named before.
 *
 * @param userId the account whose newly issued session the store should name
 */
async function cookieStoreCatchesUp(userId: string): Promise<void> {
	cookiesMock.mockResolvedValue(cookieStoreOf(await sessionCookieFor(userId)));
}

describe("the session gate after a mid-request session rotation", () => {
	beforeEach(async () => {
		redirected.mockClear();
		await prisma.twoFactor.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
	});

	it("keeps the caller signed in after confirming an enrolment", async () => {
		const { user } = await signedInUser("rotate-on@example.test", PASSWORD);
		const staleHeader = await headersMock();
		const enrolment = await beginEnrolment(PASSWORD);
		const secret = new URL(enrolment.totpUri).searchParams.get("secret") ?? "";

		await confirmEnrolment(totp(secret));
		await cookieStoreCatchesUp(user.id);

		// The header is still the one the browser sent, and the row it names is gone. That is the
		// condition, not an artefact of the test: assert it rather than assume it.
		expect(await headersMock()).toBe(staleHeader);
		expect(await prisma.session.count()).toBe(1);

		await expect(requireSession()).resolves.toMatchObject({ id: user.id, twoFactorEnabled: true });
		expect(redirected).not.toHaveBeenCalled();
	});

	it("keeps the caller signed in after removing an enrolment", async () => {
		const { user } = await signedInUser("rotate-off@example.test", PASSWORD);
		const enrolment = await beginEnrolment(PASSWORD);
		const secret = new URL(enrolment.totpUri).searchParams.get("secret") ?? "";
		await confirmEnrolment(totp(secret));
		await refreshSession(user.id);

		await endEnrolment(PASSWORD);
		await cookieStoreCatchesUp(user.id);

		await expect(requireSession()).resolves.toMatchObject({ id: user.id, twoFactorEnabled: false });
		expect(redirected).not.toHaveBeenCalled();
	});

	/**
	 * The rotation must not become a way *in*. Reading the cookie store rather than the header would
	 * be worth nothing if it stopped noticing that the session it names has been revoked.
	 */
	it("still turns away a caller whose session has been revoked", async () => {
		const { user } = await signedInUser("revoked@example.test", PASSWORD);
		await prisma.session.deleteMany({ where: { userId: user.id } });

		await expect(currentUser()).resolves.toBeNull();
		await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
	});
});
