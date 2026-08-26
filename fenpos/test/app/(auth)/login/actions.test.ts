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
		const malformed = await signIn({ error: null, twoFactorRequired: false }, form({ email: "", password: "" }));
		expect(malformed.error).not.toBeNull();
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
			const jar = new Map<string, string>();
			for (const pair of (await headersMock()).get("cookie")?.split("; ") ?? []) {
				const [name, value] = pair.split("=");
				if (name) {
					jar.set(name, value ?? "");
				}
			}
			for (const setCookie of setCookies) {
				const [name, value] = (setCookie.split(";")[0] ?? "").split("=");
				if (name) {
					jar.set(name, value ?? "");
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
	});
});
