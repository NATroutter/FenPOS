import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * That holding one valid credential does not buy unlimited guesses at somebody else's account.
 *
 * The per-address sign-in throttle counts every attempt from an address, whoever it names. Clearing
 * it when a password is accepted looks reasonable — the caller has proved they are not a stranger —
 * but the bucket covers the whole address rather than the account, so an attacker who holds any one
 * working credential could spend attempts guessing a *different* account, clear the bucket with
 * their own sign-in, and repeat. The per-account failure count is cleared on success; the
 * per-address throttle deliberately is not.
 *
 * Driven through the real `signIn` action and the real limiter, with only `signInEmail`,
 * `next/headers` and the caller's address stubbed, the way the neighbouring action tests are. A test
 * that mocked the limiter would prove nothing about the arm that clears it.
 */
vi.mock("next/navigation", () => ({
	redirect: (destination: string) => {
		throw new Error(`REDIRECT:${destination}`);
	},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "198.51.100.44",
	getUserAgent: async () => "vitest",
}));

const signInEmail = vi.fn();
vi.mock("@/lib/auth/auth", () => ({ auth: { api: { signInEmail: (a: unknown) => signInEmail(a) } } }));

const { signIn } = await import("@/app/(auth)/login/actions");
const { signInLimiter } = await import("@/lib/auth/rate-limit");
const { auditDb, prisma } = await import("@/lib/db");
const { setSetting } = await import("@/lib/settings/settings-service");

const ADDRESS = "198.51.100.44";
/** An account the attacker legitimately holds the password to. */
const ATTACKER = "attacker@example.test";
/** The account being guessed at. */
const VICTIM = "victim@example.test";

/** Small enough that the budget is reached in a handful of calls rather than by wall-clock luck. */
const ATTEMPTS_PER_MINUTE = 3;

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [k, v] of Object.entries(fields)) data.set(k, v);
	return data;
}

/** One wrong guess at the victim's account. */
function guessVictim() {
	signInEmail.mockRejectedValueOnce(new Error("INVALID_EMAIL_OR_PASSWORD"));
	return signIn({ error: null, twoFactorRequired: false }, form({ email: VICTIM, password: "guess" }));
}

/**
 * The attacker signing in to their own account, which carries a second factor.
 *
 * This is the arm that matters: the password is accepted and no session is created, so it is the
 * cheapest way to reach the success path repeatedly without ever completing a sign-in.
 */
function attackerSignIn() {
	signInEmail.mockResolvedValueOnce({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
	return signIn({ error: null, twoFactorRequired: false }, form({ email: ATTACKER, password: "correct" }));
}

beforeEach(async () => {
	signInLimiter.reset(ADDRESS);
	signInEmail.mockReset();
	await prisma.setting.deleteMany({});
	await prisma.user.deleteMany({});
	await auditDb.auditEvent.deleteMany({});
	await auditDb.auditAnchor.deleteMany({});
	await auditDb.auditEpoch.deleteMany({});
	// The account the accepted password belongs to, so the success-stage audit path finds it.
	await prisma.user.create({ data: { id: "att", name: "Att", email: ATTACKER } });
	await setSetting("auth.signInAttemptsPerMinute", ATTEMPTS_PER_MINUTE);
});

describe("the sign-in throttle against an address that holds one valid credential", () => {
	it("refuses a plain guessing run once the address is out of budget", async () => {
		const errors: (string | null)[] = [];
		for (let attempt = 0; attempt < ATTEMPTS_PER_MINUTE + 1; attempt++) {
			errors.push((await guessVictim()).error);
		}

		// The last one is refused by the throttle rather than by the credential, which is the
		// distinction the message carries and the reason both are asserted.
		expect(errors[ATTEMPTS_PER_MINUTE - 1]).toMatch(/do not match/i);
		expect(errors[ATTEMPTS_PER_MINUTE]).toMatch(/too many/i);
	});

	it("does not hand the address a fresh budget when a password is accepted", async () => {
		// Two guesses, leaving exactly one attempt in the window.
		expect((await guessVictim()).error).toMatch(/do not match/i);
		expect((await guessVictim()).error).toMatch(/do not match/i);

		// The third call is the attacker's own, and it is accepted: the password is right, the second
		// factor is still owed, and no session exists at the end of it.
		const attacker = await attackerSignIn();
		expect(attacker.twoFactorRequired).toBe(true);
		expect(attacker.error).toBeNull();
		expect(await prisma.session.count()).toBe(0);

		// The accepted password bought nothing. The address is out of budget and the next guess is
		// refused by the throttle, exactly as it is for a caller holding no credential at all.
		expect((await guessVictim()).error).toMatch(/too many/i);
	});

	it("still clears the throttle for an address that has not spent its budget", async () => {
		// The guard above must not be mistaken for the limiter having stopped working: a fresh
		// address, or one whose window has been reset, is served normally.
		signInLimiter.reset(ADDRESS);
		expect((await guessVictim()).error).toMatch(/do not match/i);
	});
});
