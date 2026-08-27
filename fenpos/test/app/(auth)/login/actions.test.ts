import { beforeEach, describe, expect, it, vi } from "vitest";
import { headersMock, refreshSession, signedInUser } from "@/test/helpers/session";
import { totp } from "@/test/helpers/totp";

/**
 * Sign-in.
 *
 * The property under test is that failures are indistinguishable: a wrong password, an unknown
 * address, a banned account and a malformed submission must all produce one message. Telling them
 * apart discloses which addresses hold accounts, which is useful only to someone who should not
 * be here.
 */
vi.mock("next/navigation", () => ({
	redirect: (destination: string) => {
		throw new Error(`REDIRECT:${destination}`);
	},
}));

// `signIn` and `verifyTwoFactor` pass this request's headers to Better Auth. There is no live
// request here for `headers()` to read on its own, so it is routed through `headersMock` — the same
// stand-in `test/helpers/session.ts` points at a real session for the tests below that need one; the
// tests that don't leave it at its default of an empty jar.
vi.mock("next/headers", () => ({ headers: () => headersMock() }));

vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.30",
	getUserAgent: async () => "vitest",
}));

/**
 * `@/lib/auth/auth` is mocked module-wide because every caller under test — this file's own
 * `signIn`/`verifyTwoFactor` imports, and `lib/auth/two-factor.ts`'s enrolment helpers the
 * "two-factor at sign-in" tests drive to set an account up — resolve `auth` through the same
 * ordinary import, which Vitest intercepts regardless of which file asks for it. The plain
 * `signIn` tests above want full control over what `signInEmail` returns, so it stays a bare
 * `vi.fn()`; the two-factor tests instead point every method they need at the real plugin, the
 * way `set-password/actions.test.ts` points `setUserPasswordApi` at the real `setUserPassword`.
 */
const signInEmail = vi.fn();
const verifyTOTPApi = vi.fn();
const verifyBackupCodeApi = vi.fn();
const getSessionApi = vi.fn();
const enableTwoFactorApi = vi.fn();
vi.mock("@/lib/auth/auth", () => ({
	auth: {
		api: {
			signInEmail: (args: unknown) => signInEmail(args),
			verifyTOTP: (args: unknown) => verifyTOTPApi(args),
			verifyBackupCode: (args: unknown) => verifyBackupCodeApi(args),
			getSession: (args: unknown) => getSessionApi(args),
			enableTwoFactor: (args: unknown) => enableTwoFactorApi(args),
		},
	},
}));

const { signIn, verifyTwoFactor } = await import("@/app/(auth)/login/actions");
const { signInLimiter } = await import("@/lib/auth/rate-limit");
const { prisma } = await import("@/lib/db");
const { setSetting } = await import("@/lib/settings/settings-service");
const { beginEnrolment, confirmEnrolment } = await import("@/lib/auth/two-factor");
const actualAuth = await vi.importActual<typeof import("@/lib/auth/auth")>("@/lib/auth/auth");

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		data.set(key, value);
	}
	return data;
}

describe("signIn", () => {
	beforeEach(async () => {
		signInLimiter.reset("203.0.113.30");
		signInEmail.mockReset();
		headersMock.mockReset().mockResolvedValue(new Headers());
		await prisma.setting.deleteMany({});
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
	});

	it("gives one message for a wrong password and for an unknown address", async () => {
		signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

		const wrongPassword = await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "known@example.com", password: "nope" }),
		);
		signInLimiter.reset("203.0.113.30");
		const unknownAddress = await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "nobody@example.com", password: "nope" }),
		);

		expect(wrongPassword.error).toBe(unknownAddress.error);
		expect(wrongPassword.error).not.toBeNull();
	});

	it("gives the same message for a malformed submission", async () => {
		signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));
		const wrongPassword = await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "known@example.com", password: "nope" }),
		);

		signInLimiter.reset("203.0.113.30");
		signInEmail.mockClear();
		const malformed = await signIn({ error: null, twoFactorRequired: false }, form({ email: "", password: "" }));

		// Compared against the wrong-password message rather than merely asserted non-null. "The same
		// message" is the property this test is named for, and a bare non-null assertion stays green
		// against a branch that answers "an email address is required" — which is the disclosure the
		// uniform message exists to refuse.
		expect(malformed.error).toBe(wrongPassword.error);
		expect(signInEmail).not.toHaveBeenCalled();
	});

	it("redirects to the dashboard on success", async () => {
		signInEmail.mockResolvedValue({ user: { id: "u1" }, token: "tok-u1" });

		await expect(
			signIn(
				{ error: null, twoFactorRequired: false },
				form({ email: "owner@example.com", password: "a-long-password" }),
			),
		).rejects.toThrow("REDIRECT:/dashboard");
	});

	it("throttles before it examines the submission", async () => {
		signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

		const attempts = [];
		for (let index = 0; index < 6; index += 1) {
			attempts.push(
				await signIn({ error: null, twoFactorRequired: false }, form({ email: "a@example.com", password: "x" })),
			);
		}

		expect(attempts.at(-1)?.error).toMatch(/too many/i);
	});
});

/**
 * The two gates that run before any credential is examined.
 *
 * Both refuse with the *same* message a wrong password gets. That is the property worth pinning: an
 * allowlist or a lockout that announced itself would tell an attacker they had found a real install,
 * or a real account, and hand them a way to enumerate either.
 */
describe("the gates before the credential", () => {
	/** A fresh account, returning the address to sign in with. Ids are per-case. */
	async function account(id: string): Promise<string> {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com` } });
		return `${id}@example.com`;
	}

	beforeEach(async () => {
		signInLimiter.reset("203.0.113.30");
		signInEmail.mockReset();
		headersMock.mockReset().mockResolvedValue(new Headers());
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
	});

	describe("address allowlist", () => {
		it("refuses an address that is not on it, without examining the credential", async () => {
			signInEmail.mockResolvedValue({ user: { id: "u1" }, token: "tok-u1" });
			await setSetting("auth.ipAllowlist", "10.0.0.0/8");

			const result = await signIn(
				{ error: null, twoFactorRequired: false },
				form({ email: "known@example.com", password: "correct" }),
			);

			expect(result.error).not.toBeNull();
			// Refused before the password is even looked at, so a barred address cannot be used to test
			// passwords either.
			expect(signInEmail).not.toHaveBeenCalled();
		});

		it("gives a barred address the same message a wrong password gets", async () => {
			signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));
			const wrongPassword = await signIn(
				{ error: null, twoFactorRequired: false },
				form({ email: "known@example.com", password: "nope" }),
			);

			signInLimiter.reset("203.0.113.30");
			await setSetting("auth.ipAllowlist", "10.0.0.0/8");
			const barred = await signIn(
				{ error: null, twoFactorRequired: false },
				form({ email: "known@example.com", password: "correct" }),
			);

			expect(barred.error).toBe(wrongPassword.error);
		});

		it("records the refusal so the record says what happened", async () => {
			await setSetting("auth.ipAllowlist", "10.0.0.0/8");

			await signIn(
				{ error: null, twoFactorRequired: false },
				form({ email: "known@example.com", password: "correct" }),
			);

			const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
			expect(row.outcome).toBe("DENIED");
			expect(row.detail).toContain("address-not-allowed");
		});

		it("allows an address on it", async () => {
			signInEmail.mockResolvedValue({ user: { id: "u1" }, token: "tok-u1" });
			// 203.0.113.30 is what the request-context mock above returns.
			await setSetting("auth.ipAllowlist", "203.0.113.0/24");

			await expect(
				signIn({ error: null, twoFactorRequired: false }, form({ email: "known@example.com", password: "correct" })),
			).rejects.toThrow("REDIRECT:/dashboard");
		});

		it("allows every address while it is empty", async () => {
			signInEmail.mockResolvedValue({ user: { id: "u1" }, token: "tok-u1" });

			await expect(
				signIn({ error: null, twoFactorRequired: false }, form({ email: "known@example.com", password: "correct" })),
			).rejects.toThrow("REDIRECT:/dashboard");
		});
	});

	describe("account lockout", () => {
		it("counts a wrong password toward the lock", async () => {
			await setSetting("auth.lockoutAfterFailures", 2);
			const email = await account("li1");
			signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

			await signIn({ error: null, twoFactorRequired: false }, form({ email, password: "wrong" }));
			signInLimiter.reset("203.0.113.30");
			await signIn({ error: null, twoFactorRequired: false }, form({ email, password: "wrong" }));

			const user = await prisma.user.findUniqueOrThrow({ where: { id: "li1" } });
			expect(user.lockedUntil).not.toBeNull();
		});

		it("refuses a locked account without examining the credential", async () => {
			await setSetting("auth.lockoutAfterFailures", 2);
			const email = await account("li2");
			await prisma.user.update({ where: { id: "li2" }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
			signInEmail.mockResolvedValue({ user: { id: "li2" }, token: "tok-li2" });

			const result = await signIn({ error: null, twoFactorRequired: false }, form({ email, password: "correct" }));

			expect(result.error).not.toBeNull();
			expect(signInEmail).not.toHaveBeenCalled();
		});

		it("gives a locked account the same message a wrong password gets", async () => {
			// The branch's own comment says "deliberately not 'this account is locked'", because a message
			// that said so would confirm the address holds an account and hand an attacker a way to
			// enumerate them by locking each one in turn. The test above asserts only that *some* message
			// came back, which stays green against exactly that disclosure — so the comparison lives here.
			await setSetting("auth.lockoutAfterFailures", 2);
			const email = await account("li6");
			signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));
			const wrongPassword = await signIn({ error: null, twoFactorRequired: false }, form({ email, password: "wrong" }));

			signInLimiter.reset("203.0.113.30");
			await prisma.user.update({ where: { id: "li6" }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
			const locked = await signIn({ error: null, twoFactorRequired: false }, form({ email, password: "wrong" }));

			expect(locked.error).toBe(wrongPassword.error);
		});

		it("records a locked refusal as such", async () => {
			await setSetting("auth.lockoutAfterFailures", 2);
			const email = await account("li3");
			await prisma.user.update({ where: { id: "li3" }, data: { lockedUntil: new Date(Date.now() + 60_000) } });

			await signIn({ error: null, twoFactorRequired: false }, form({ email, password: "correct" }));

			const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
			expect(row.detail).toContain("locked");
		});

		it("forgets the failures once a sign-in succeeds", async () => {
			await setSetting("auth.lockoutAfterFailures", 5);
			const email = await account("li4");
			signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));
			await signIn({ error: null, twoFactorRequired: false }, form({ email, password: "wrong" }));
			signInLimiter.reset("203.0.113.30");

			signInEmail.mockReset();
			signInEmail.mockResolvedValue({ user: { id: "li4" }, token: "tok-li4" });
			await expect(
				signIn({ error: null, twoFactorRequired: false }, form({ email, password: "correct" })),
			).rejects.toThrow("REDIRECT:/dashboard");

			const user = await prisma.user.findUniqueOrThrow({ where: { id: "li4" } });
			expect(user.failedSignInCount).toBe(0);
		});

		it("counts nothing while the setting is zero", async () => {
			const email = await account("li5");
			signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

			await signIn({ error: null, twoFactorRequired: false }, form({ email, password: "wrong" }));

			const user = await prisma.user.findUniqueOrThrow({ where: { id: "li5" } });
			expect(user.failedSignInCount).toBe(0);
			expect(user.lockedUntil).toBeNull();
		});
	});
});

/**
 * A banned account, refused by the library rather than by the panel.
 *
 * `signIn`'s own doc comment claims the ban is "enforced at the credential layer rather than by a
 * check the panel could forget to make", and this file's header names a banned account among the
 * refusals that must be indistinguishable — but every test above mocks `signInEmail`, which refuses
 * identically whatever the reason and so could never tell either claim from its opposite. This one
 * drives the real endpoint with the account's *correct* password, leaving the ban as the only thing
 * that can turn it away.
 */
describe("a banned account", () => {
	beforeEach(async () => {
		signInLimiter.reset("203.0.113.30");
		headersMock.mockReset().mockResolvedValue(new Headers());
		signInEmail
			.mockReset()
			.mockImplementation((args: Parameters<typeof actualAuth.auth.api.signInEmail>[0]) =>
				actualAuth.auth.api.signInEmail(args),
			);

		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
	});

	it("is refused with the message a wrong password gets, and is left with no session", async () => {
		const { user } = await signedInUser("banned@example.test", "correct horse battery staple");
		await prisma.user.update({ where: { id: user.id }, data: { banned: true, banReason: "testing" } });
		// The sign-in `signedInUser` performed left a live session behind; the count below is about the
		// session this test's own refused attempt did or did not create.
		await prisma.session.deleteMany({});
		headersMock.mockResolvedValue(new Headers());

		const banned = await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "banned@example.test", password: "correct horse battery staple" }),
		);

		signInLimiter.reset("203.0.113.30");
		const wrongPassword = await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "banned@example.test", password: "not the password at all" }),
		);

		expect(banned.error).toBe(wrongPassword.error);
		expect(await prisma.session.count()).toBe(0);
	});
});

/**
 * The challenge that runs between a right password and a session, for an account enrolled in
 * two-factor.
 *
 * Driven against the real plugin, not a mock of it: a stubbed `verifyTOTP` would pass against a
 * secret this suite invented, and the property worth proving is that a code computed the way a real
 * authenticator computes one is what `verifyTwoFactor` actually accepts.
 */
describe("two-factor at sign-in", () => {
	/**
	 * Wraps a real `auth.api.*` method so that any cookie its response sets is merged into
	 * `headersMock`'s jar before the caller sees the result — the hand-off a browser performs on its
	 * own by sending a `Set-Cookie` response back as the next request's `Cookie` header.
	 *
	 * `signIn` and `verifyTwoFactor` are driven here as two separate calls, standing in for two
	 * separate form submissions, and nothing but the plugin's own challenge cookie is supposed to
	 * carry state between them — the same property `SignInState.twoFactorRequired`'s doc comment
	 * describes for the real form. Without this, `signInEmail`'s challenge cookie would land nowhere
	 * this suite can see, and `verifyTwoFactor` would have nothing to check the submitted code
	 * against.
	 *
	 * `returnHeaders: true` is Better Call's own escape hatch for reading a response's headers
	 * alongside its body — see `endpoint.mjs`'s `context.returnHeaders ? { headers, response } :
	 * response` — but the generated `auth.api.*` types describe only the plain-body shape, so the
	 * richer shape is asserted here rather than inferred.
	 *
	 * @param method a real, unmocked `auth.api.*` method, called with whatever args the caller gives it
	 * @param args the arguments to call it with
	 * @returns the method's ordinary response, its cookie already folded into `headersMock`
	 */
	async function withCookieHandoff<Response>(
		method: (args: unknown) => Promise<unknown>,
		args: unknown,
	): Promise<Response> {
		const { headers: responseHeaders, response } = (await method({
			...(args as Record<string, unknown>),
			returnHeaders: true,
		})) as { headers: Headers; response: Response };

		const setCookies = responseHeaders.getSetCookie();
		if (setCookies.length > 0) {
			// `...rest` rather than a destructured second element, in both loops below: Better Auth's
			// cookie values are URL-encoded today, so splitting on the first "=" happens to work, but a
			// value that ever contained an unencoded "=" would otherwise be silently truncated.
			const jar = new Map<string, string>();
			for (const pair of (await headersMock()).get("cookie")?.split("; ") ?? []) {
				const [name, ...rest] = pair.split("=");
				if (name) {
					jar.set(name, rest.join("="));
				}
			}
			for (const setCookie of setCookies) {
				const [name, ...rest] = (setCookie.split(";")[0] ?? "").split("=");
				if (name) {
					jar.set(name, rest.join("="));
				}
			}
			headersMock.mockResolvedValue(
				new Headers({ cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") }),
			);
		}

		return response;
	}

	/**
	 * Creates a credential account, enrols it in two-factor with a real code, and signs it back out —
	 * leaving nothing but the enrolment behind for a later `signIn` in the test itself to challenge.
	 *
	 * Signing out matters here beyond hygiene: `signedInUser` leaves a live session behind, and
	 * `confirmEnrolment` rotates it into another one — either row left standing would be counted by
	 * the very assertions ("no session yet", "exactly one session now") these tests exist to make.
	 *
	 * @param email the new account's address
	 * @param password the new account's password
	 * @param withRecoveryCodes when true, the recovery codes come back alongside the secret
	 * @returns the TOTP secret, or the secret and the recovery codes together when asked for both
	 */
	async function enrolledUser(email: string, password: string): Promise<string>;
	async function enrolledUser(
		email: string,
		password: string,
		withRecoveryCodes: true,
	): Promise<{ secret: string; recoveryCodes: string[] }>;
	async function enrolledUser(
		email: string,
		password: string,
		withRecoveryCodes = false,
	): Promise<string | { secret: string; recoveryCodes: string[] }> {
		const { user } = await signedInUser(email, password);
		const enrolment = await beginEnrolment(password);
		const secret = new URL(enrolment.totpUri).searchParams.get("secret") ?? "";
		await confirmEnrolment(totp(secret));
		// `confirmEnrolment` just rotated the session — see `refreshSession`'s doc comment.
		await refreshSession(user.id);
		await actualAuth.auth.api.signOut({ headers: await headersMock() });

		return withRecoveryCodes ? { secret, recoveryCodes: enrolment.recoveryCodes } : secret;
	}

	beforeEach(async () => {
		signInLimiter.reset("203.0.113.30");
		headersMock.mockReset().mockResolvedValue(new Headers());

		// Every method `signIn`, `verifyTwoFactor` and the enrolment helpers call is pointed at the
		// real plugin — the plain `signIn` describe above wants the mock's default of "returns
		// undefined", but these tests want the genuine behaviour that only the real plugin has.
		// `signInEmail` and `verifyTOTP`/`verifyBackupCode` go through `withCookieHandoff`: each is a
		// separate simulated request, and the challenge cookie the first sets is what the next one
		// must be able to read back.
		signInEmail
			.mockReset()
			.mockImplementation((args: Parameters<typeof actualAuth.auth.api.signInEmail>[0]) =>
				withCookieHandoff<Awaited<ReturnType<typeof actualAuth.auth.api.signInEmail>>>(
					actualAuth.auth.api.signInEmail as (args: unknown) => Promise<unknown>,
					args,
				),
			);
		verifyTOTPApi
			.mockReset()
			.mockImplementation((args: Parameters<typeof actualAuth.auth.api.verifyTOTP>[0]) =>
				withCookieHandoff<Awaited<ReturnType<typeof actualAuth.auth.api.verifyTOTP>>>(
					actualAuth.auth.api.verifyTOTP as (args: unknown) => Promise<unknown>,
					args,
				),
			);
		verifyBackupCodeApi
			.mockReset()
			.mockImplementation((args: Parameters<typeof actualAuth.auth.api.verifyBackupCode>[0]) =>
				withCookieHandoff<Awaited<ReturnType<typeof actualAuth.auth.api.verifyBackupCode>>>(
					actualAuth.auth.api.verifyBackupCode as (args: unknown) => Promise<unknown>,
					args,
				),
			);
		getSessionApi
			.mockReset()
			.mockImplementation((args: Parameters<typeof actualAuth.auth.api.getSession>[0]) =>
				actualAuth.auth.api.getSession(args),
			);
		enableTwoFactorApi
			.mockReset()
			.mockImplementation((args: Parameters<typeof actualAuth.auth.api.enableTwoFactor>[0]) =>
				actualAuth.auth.api.enableTwoFactor(args),
			);

		await prisma.twoFactor.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
	});

	it("defers instead of signing in when the account is enrolled", async () => {
		await enrolledUser("challenged@example.test", "correct horse battery staple");
		const state = await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "challenged@example.test", password: "correct horse battery staple" }),
		);

		expect(state.twoFactorRequired).toBe(true);
		expect(state.error).toBeNull();
		expect(await prisma.session.count()).toBe(0);
	});

	it("records a refused code as DENIED without saying whose account it was", async () => {
		await enrolledUser("refused@example.test", "correct horse battery staple");
		await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "refused@example.test", password: "correct horse battery staple" }),
		);

		const state = await verifyTwoFactor({ error: null, twoFactorRequired: true }, form({ code: "000000" }));
		expect(state.error).not.toBeNull();
		expect(state.twoFactorRequired).toBe(true);

		const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("auth:two-factor");
		expect(row.outcome).toBe("DENIED");
		// The property under test: nothing about whose account this was reaches the row. Asserting only
		// `action`/`outcome` above would stay green even if the actor carried the submitted email.
		expect(row.actorUserId).toBeNull();
		expect(row.actorEmail).toBe("");
		expect(row.detail).not.toContain("000000");
	});

	it("signs in on a real code", async () => {
		const secret = await enrolledUser("accepted@example.test", "correct horse battery staple");
		await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "accepted@example.test", password: "correct horse battery staple" }),
		);

		await expect(
			verifyTwoFactor({ error: null, twoFactorRequired: true }, form({ code: totp(secret) })),
		).rejects.toThrow("REDIRECT:/dashboard");

		expect(await prisma.session.count()).toBe(1);
	});

	it("signs in on a recovery code, and spends it", async () => {
		const { recoveryCodes } = await enrolledUser("recovery@example.test", "correct horse battery staple", true);
		await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "recovery@example.test", password: "correct horse battery staple" }),
		);

		await expect(
			verifyTwoFactor({ error: null, twoFactorRequired: true }, form({ code: recoveryCodes[0] })),
		).rejects.toThrow("REDIRECT:/dashboard");

		// The same code a second time must not work.
		await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "recovery@example.test", password: "correct horse battery staple" }),
		);
		const state = await verifyTwoFactor({ error: null, twoFactorRequired: true }, form({ code: recoveryCodes[0] }));
		expect(state.error).not.toBeNull();

		// `state.error` alone is satisfied by any refusal, including one where the challenge cookie
		// itself was never examined — which this second round is at genuine risk of, since (unlike the
		// first) nothing signs out between challenges here, so the jar now carries a rotated session
		// cookie and `withCookieHandoff` is doing more merging than on the first pass. Proving the spent
		// code specifically, rather than the challenge generally, needs a code that is still good: a
		// *different* recovery code against the very same live challenge must still redirect.
		await expect(
			verifyTwoFactor({ error: null, twoFactorRequired: true }, form({ code: recoveryCodes[1] })),
		).rejects.toThrow("REDIRECT:/dashboard");
	});

	/**
	 * One submission, one attempt.
	 *
	 * The plugin allows five tries against a single challenge. Trying the authenticator and then
	 * falling back to the recovery code spent two of them for every wrong code an operator typed, so
	 * the challenge died on the third submission rather than the fifth — and the account-wide lockout,
	 * which covers the recovery codes too, fired at five wrong codes rather than ten. Four wrong codes
	 * followed by a right one is the cheapest thing that tells the two behaviours apart.
	 */
	it("spends one attempt per submission, so a fifth submission is still examined", async () => {
		const secret = await enrolledUser("budget@example.test", "correct horse battery staple");
		await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "budget@example.test", password: "correct horse battery staple" }),
		);

		for (let submission = 0; submission < 4; submission += 1) {
			const state = await verifyTwoFactor({ error: null, twoFactorRequired: true }, form({ code: "000000" }));
			expect(state.error).not.toBeNull();
		}

		await expect(
			verifyTwoFactor({ error: null, twoFactorRequired: true }, form({ code: totp(secret) })),
		).rejects.toThrow("REDIRECT:/dashboard");
	});

	it("keeps the session the second factor just issued, even under a cap the eviction order would miss", async () => {
		const secret = await enrolledUser("capped@example.test", "correct horse battery staple");
		const user = await prisma.user.findFirstOrThrow({ where: { email: "capped@example.test" } });

		// Stamped as seen an hour in the *future*, so the ordinary "most recently seen survives"
		// ordering in `enforceSessionCap` would rank this ahead of the session `verifyTwoFactor` is
		// about to create — the only thing that can save the new session here is `keepSessionId`
		// pinning it, which is exactly the property this test exists to catch a regression in.
		await prisma.session.create({
			data: {
				id: "capped-decoy",
				token: "capped-decoy-token",
				userId: user.id,
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				lastSeenAt: new Date(Date.now() + 60 * 60 * 1000),
			},
		});
		await setSetting("auth.maxConcurrentSessions", 1);

		await signIn(
			{ error: null, twoFactorRequired: false },
			form({ email: "capped@example.test", password: "correct horse battery staple" }),
		);
		await expect(
			verifyTwoFactor({ error: null, twoFactorRequired: true }, form({ code: totp(secret) })),
		).rejects.toThrow("REDIRECT:/dashboard");

		const left = await prisma.session.findMany({ where: { userId: user.id }, select: { id: true } });
		expect(left).toHaveLength(1);
		expect(left[0]?.id).not.toBe("capped-decoy");
	});
});
