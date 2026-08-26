import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The panel's session gate.
 *
 * `redirect` signals by throwing, which is what the production code depends on and what these
 * tests assert against: a redirect is observed as a throw carrying its destination, not as a
 * return value. The Next.js request APIs are stubbed because they are request-bound and this
 * module's logic is not.
 */
const redirected = vi.fn((destination: string) => {
	throw new Error(`REDIRECT:${destination}`);
});

vi.mock("next/navigation", () => ({ redirect: redirected }));
// `cookies` as well as `headers`: `authHeaders` reads the session cookie from the store, because
// that is the only view of the jar Next keeps current across a server action. Both stand for a
// request carrying no cookies at all — the session itself comes from the `getSession` stub below.
vi.mock("next/headers", () => ({
	headers: async () => new Headers(),
	cookies: async () => ({ getAll: () => [] }),
}));

const clientAddress = vi.fn(async () => "203.0.113.30");
vi.mock("@/lib/request-context", () => ({
	getClientAddress: () => clientAddress(),
	getUserAgent: async () => "vitest",
}));

const getSession = vi.fn();
const signOut = vi.fn();
vi.mock("@/lib/auth/auth", () => ({
	auth: { api: { getSession: () => getSession(), signOut: () => signOut() } },
}));

const claimed = vi.fn();
vi.mock("@/lib/auth/setup-key", () => ({ isInstallClaimed: () => claimed() }));

const { currentSessionId, currentUser, requireSession } = await import("@/lib/auth/require-session");
const { prisma } = await import("@/lib/db");
const { setSetting } = await import("@/lib/settings/settings-service");

describe("requireSession", () => {
	beforeEach(() => {
		redirected.mockClear();
		getSession.mockReset();
		claimed.mockReset().mockResolvedValue(true);
	});

	it("returns the signed-in user", async () => {
		getSession.mockResolvedValue({
			session: { id: "sess-1" },
			user: { id: "u1", name: "Owner", email: "owner@example.com", isSuperuser: true, mustChangePassword: false },
		});

		await expect(requireSession()).resolves.toEqual({
			id: "u1",
			name: "Owner",
			email: "owner@example.com",
			isSuperuser: true,
			mustChangePassword: false,
			sessionId: "sess-1",
			twoFactorEnabled: false,
		});
	});

	it("sends an unauthenticated caller to sign-in", async () => {
		getSession.mockResolvedValue(null);

		await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
	});

	it("sends an unauthenticated caller on an unclaimed install to setup instead", async () => {
		getSession.mockResolvedValue(null);
		claimed.mockResolvedValue(false);

		await expect(requireSession()).rejects.toThrow("REDIRECT:/setup");
	});

	it("sends a user owing a password change to the page that takes it", async () => {
		getSession.mockResolvedValue({
			session: { id: "sess-2" },
			user: { id: "u2", name: "Staff", email: "staff@example.com", isSuperuser: false, mustChangePassword: true },
		});

		await expect(requireSession()).rejects.toThrow("REDIRECT:/set-password");
	});

	it("currentUser reports absence rather than redirecting", async () => {
		getSession.mockResolvedValue(null);

		await expect(currentUser()).resolves.toBeNull();
		expect(redirected).not.toHaveBeenCalled();
	});
});

/**
 * `panel-action.ts`'s `record()` calls this after an action's body has run, to name the session the
 * request ends up on rather than the one `gate()` resolved before the body could rotate it —
 * `changePassword`, `self:confirm-2fa` and `self:end-2fa` all do that. `getSession` stands in for the
 * live cookie read `authHeaders()` would otherwise do, so these prove the fallback logic without
 * needing a real rotation.
 */
describe("currentSessionId", () => {
	beforeEach(() => {
		getSession.mockReset();
	});

	it("reports the session the live cookie names now, not the fallback it was given", async () => {
		getSession.mockResolvedValue({
			session: { id: "sess-after-rotation" },
			user: { id: "u1", name: "Owner", email: "owner@example.com", isSuperuser: true, mustChangePassword: false },
		});

		await expect(currentSessionId("sess-before-rotation")).resolves.toBe("sess-after-rotation");
	});

	it("falls back when the live read finds nobody signed in", async () => {
		getSession.mockResolvedValue(null);

		await expect(currentSessionId("sess-before-rotation")).resolves.toBe("sess-before-rotation");
	});

	it("falls back rather than throwing when the live read itself fails", async () => {
		getSession.mockRejectedValue(new Error("no request scope"));

		await expect(currentSessionId("sess-before-rotation")).resolves.toBe("sess-before-rotation");
	});
});

/**
 * The two gates phase 6a adds, both of which apply to a session that was perfectly good when it was
 * created and may not be any more.
 */
describe("the allowlist, re-checked on every request", () => {
	beforeEach(async () => {
		redirected.mockClear();
		getSession.mockReset();
		signOut.mockReset();
		claimed.mockReset().mockResolvedValue(true);
		clientAddress.mockReset().mockResolvedValue("203.0.113.30");
		await prisma.setting.deleteMany({});
		await prisma.user.deleteMany({});
		await prisma.user.create({ data: { id: "rs1", name: "Ada", email: "ada@example.com" } });
		getSession.mockResolvedValue({
			session: { id: "sess-rs1" },
			user: { id: "rs1", name: "Ada", email: "ada@example.com", isSuperuser: false, mustChangePassword: false },
		});
	});

	it("lets a session through while the allowlist is empty", async () => {
		await expect(requireSession()).resolves.toMatchObject({ id: "rs1" });
	});

	it("lets a session through when its address still qualifies", async () => {
		await setSetting("auth.ipAllowlist", "203.0.113.0/24");

		await expect(requireSession()).resolves.toMatchObject({ id: "rs1" });
	});

	it("ends a session whose address no longer qualifies", async () => {
		await setSetting("auth.ipAllowlist", "10.0.0.0/8");

		await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
		// Destroyed rather than merely redirected: `/login` bounces an authenticated visitor to
		// `/dashboard`, so leaving the session intact would loop between the two forever.
		expect(signOut).toHaveBeenCalled();
	});
});

describe("password expiry", () => {
	beforeEach(async () => {
		redirected.mockClear();
		getSession.mockReset();
		signOut.mockReset();
		claimed.mockReset().mockResolvedValue(true);
		clientAddress.mockReset().mockResolvedValue("203.0.113.30");
		await prisma.setting.deleteMany({});
		await prisma.user.deleteMany({});
	});

	/** An account whose password was last changed `daysAgo` days ago. */
	async function accountWithPasswordAged(id: string, daysAgo: number) {
		await prisma.user.create({
			data: {
				id,
				name: id,
				email: `${id}@example.com`,
				passwordChangedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
			},
		});
		getSession.mockResolvedValue({
			session: { id: `sess-${id}` },
			user: { id, name: id, email: `${id}@example.com`, isSuperuser: false, mustChangePassword: false },
		});
	}

	it("lets an account through while the setting is zero", async () => {
		await accountWithPasswordAged("rs2", 5_000);

		await expect(requireSession()).resolves.toMatchObject({ id: "rs2" });
	});

	it("lets an account through inside the window", async () => {
		await setSetting("auth.passwordExpiryDays", 30);
		await accountWithPasswordAged("rs3", 5);

		await expect(requireSession()).resolves.toMatchObject({ id: "rs3" });
	});

	it("sends an account with an expired password to the page that takes a new one", async () => {
		await setSetting("auth.passwordExpiryDays", 30);
		await accountWithPasswordAged("rs4", 40);

		await expect(requireSession()).rejects.toThrow("REDIRECT:/set-password");
	});

	it("sets the forced-reset flag rather than only redirecting", async () => {
		await setSetting("auth.passwordExpiryDays", 30);
		await accountWithPasswordAged("rs5", 40);

		await expect(requireSession()).rejects.toThrow("REDIRECT:/set-password");

		// Load-bearing: `/set-password` bounces anyone whose flag is false to `/dashboard`, so without
		// the write the two pages would redirect to each other forever.
		const user = await prisma.user.findUniqueOrThrow({ where: { id: "rs5" } });
		expect(user.mustChangePassword).toBe(true);
	});

	it("lets an account with no recorded change date through", async () => {
		await setSetting("auth.passwordExpiryDays", 30);
		await prisma.user.create({ data: { id: "rs6", name: "rs6", email: "rs6@example.com" } });
		getSession.mockResolvedValue({
			session: { id: "sess-rs6" },
			user: { id: "rs6", name: "rs6", email: "rs6@example.com", isSuperuser: false, mustChangePassword: false },
		});

		// Every account that predates the column. Reading null as expired would force a password change
		// across the whole install the moment somebody turned the setting on.
		await expect(requireSession()).resolves.toMatchObject({ id: "rs6" });
	});
});

/**
 * The last gate: an install that requires a second factor sends an account with none to enrol one.
 */
describe("the enrolment gate", () => {
	beforeEach(async () => {
		redirected.mockClear();
		getSession.mockReset();
		signOut.mockReset();
		claimed.mockReset().mockResolvedValue(true);
		clientAddress.mockReset().mockResolvedValue("203.0.113.30");
		await prisma.setting.deleteMany({});
		await prisma.user.deleteMany({});
	});

	it("lets an un-enrolled user through while the setting is off", async () => {
		getSession.mockResolvedValue({
			session: { id: "sess-rs7" },
			user: {
				id: "rs7",
				name: "rs7",
				email: "rs7@example.com",
				isSuperuser: false,
				mustChangePassword: false,
				twoFactorEnabled: false,
			},
		});

		await expect(requireSession()).resolves.toMatchObject({ twoFactorEnabled: false });
	});

	it("sends an un-enrolled user to enrolment while the setting is on", async () => {
		await setSetting("auth.require2fa", true);
		getSession.mockResolvedValue({
			session: { id: "sess-rs8" },
			user: {
				id: "rs8",
				name: "rs8",
				email: "rs8@example.com",
				isSuperuser: false,
				mustChangePassword: false,
				twoFactorEnabled: false,
			},
		});

		await expect(requireSession()).rejects.toThrow("REDIRECT:/enrol-2fa");
	});

	it("lets an enrolled user through while the setting is on", async () => {
		await setSetting("auth.require2fa", true);
		getSession.mockResolvedValue({
			session: { id: "sess-rs9" },
			user: {
				id: "rs9",
				name: "rs9",
				email: "rs9@example.com",
				isSuperuser: false,
				mustChangePassword: false,
				twoFactorEnabled: true,
			},
		});

		await expect(requireSession()).resolves.toMatchObject({ twoFactorEnabled: true });
	});

	it("takes a forced password change first, so the two gates cannot loop", async () => {
		await setSetting("auth.require2fa", true);
		getSession.mockResolvedValue({
			session: { id: "sess-rs10" },
			user: {
				id: "rs10",
				name: "rs10",
				email: "rs10@example.com",
				isSuperuser: false,
				mustChangePassword: true,
				twoFactorEnabled: false,
			},
		});

		// Both gates would redirect; the assertion that matters is that exactly one does, and it is the
		// password one — `/set-password` is reachable without a second factor, and `/enrol-2fa` is not
		// reachable while a password change is owed.
		await expect(requireSession()).rejects.toThrow("REDIRECT:/set-password");
	});
});

/**
 * `skipEnrolmentGate` exists for exactly one caller — `panel-action.ts`'s `gate`, for the two
 * actions that are how enrolment happens — and it must skip only the gate it names. These prove the
 * other three still fire with the flag set, the same way `panel-action.test.ts` proves `gate` only
 * ever passes the flag for those two actions. Between the two files, "only the last gate is
 * skipped" is a fact the suite would catch a regression in, not a sentence in a comment.
 */
describe("skipEnrolmentGate skips only the last gate", () => {
	beforeEach(async () => {
		redirected.mockClear();
		getSession.mockReset();
		signOut.mockReset();
		claimed.mockReset().mockResolvedValue(true);
		clientAddress.mockReset().mockResolvedValue("203.0.113.30");
		await prisma.session.deleteMany({});
		await prisma.setting.deleteMany({});
		await prisma.user.deleteMany({});
	});

	it("still redirects a forced password change", async () => {
		getSession.mockResolvedValue({
			session: { id: "sess-rs13" },
			user: {
				id: "rs13",
				name: "rs13",
				email: "rs13@example.com",
				isSuperuser: false,
				mustChangePassword: true,
				twoFactorEnabled: false,
			},
		});

		await expect(requireSession({ skipEnrolmentGate: true })).rejects.toThrow("REDIRECT:/set-password");
	});

	it("still ends a session from a disallowed address", async () => {
		await setSetting("auth.ipAllowlist", "10.0.0.0/8");
		getSession.mockResolvedValue({
			session: { id: "sess-rs14" },
			user: {
				id: "rs14",
				name: "rs14",
				email: "rs14@example.com",
				isSuperuser: false,
				mustChangePassword: false,
				twoFactorEnabled: false,
			},
		});

		await expect(requireSession({ skipEnrolmentGate: true })).rejects.toThrow("REDIRECT:/login");
		expect(signOut).toHaveBeenCalled();
	});

	it("still ends a session that has been idle too long", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		await prisma.user.create({ data: { id: "rs15", name: "rs15", email: "rs15@example.com" } });
		const staleAt = new Date(Date.now() - 40 * 60 * 1000);
		await prisma.session.create({
			data: {
				id: "sess-rs15",
				token: "t-rs15",
				userId: "rs15",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				createdAt: staleAt,
				updatedAt: staleAt,
				lastSeenAt: staleAt,
			},
		});
		getSession.mockResolvedValue({
			session: { id: "sess-rs15" },
			user: {
				id: "rs15",
				name: "rs15",
				email: "rs15@example.com",
				isSuperuser: false,
				mustChangePassword: false,
				twoFactorEnabled: false,
			},
		});

		await expect(requireSession({ skipEnrolmentGate: true })).rejects.toThrow("REDIRECT:/login");
		expect(signOut).toHaveBeenCalled();
	});
});

/**
 * `sessionVerdict`'s `mustChangePassword` branch stamps the session directly rather than through
 * `keepSessionAlive`, because that helper refuses to write once a session already reads as idle past
 * the timeout — right for every other caller, wrong for a branch that must be reachable regardless of
 * how long the operator has been on `/set-password`. These prove the two symptoms that gate would
 * otherwise cause here: a session already past the timeout still gets its clock moved, and the
 * request right after the flag clears is not judged against a stamp frozen since the reset began.
 */
describe("the forced password-change branch keeps lastSeenAt moving", () => {
	beforeEach(async () => {
		redirected.mockClear();
		getSession.mockReset();
		signOut.mockReset();
		claimed.mockReset().mockResolvedValue(true);
		clientAddress.mockReset().mockResolvedValue("203.0.113.30");
		await prisma.session.deleteMany({});
		await prisma.setting.deleteMany({});
		await prisma.user.deleteMany({});
	});

	it("stamps the session even though it already reads as idle past the timeout", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		await prisma.user.create({ data: { id: "rs20", name: "rs20", email: "rs20@example.com" } });
		const staleAt = new Date(Date.now() - 40 * 60 * 1000);
		await prisma.session.create({
			data: {
				id: "sess-rs20",
				token: "t-rs20",
				userId: "rs20",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				createdAt: staleAt,
				updatedAt: staleAt,
				lastSeenAt: staleAt,
			},
		});
		getSession.mockResolvedValue({
			session: { id: "sess-rs20" },
			user: {
				id: "rs20",
				name: "rs20",
				email: "rs20@example.com",
				isSuperuser: false,
				mustChangePassword: true,
				twoFactorEnabled: false,
			},
		});

		await expect(requireSession()).rejects.toThrow("REDIRECT:/set-password");

		const session = await prisma.session.findUniqueOrThrow({ where: { id: "sess-rs20" } });
		expect(session.lastSeenAt?.getTime()).toBeGreaterThan(staleAt.getTime());
	});

	it("does not sign the operator out on the request right after the flag clears", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		await prisma.user.create({ data: { id: "rs21", name: "rs21", email: "rs21@example.com" } });
		const staleAt = new Date(Date.now() - 40 * 60 * 1000);
		await prisma.session.create({
			data: {
				id: "sess-rs21",
				token: "t-rs21",
				userId: "rs21",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				createdAt: staleAt,
				updatedAt: staleAt,
				lastSeenAt: staleAt,
			},
		});
		getSession.mockResolvedValue({
			session: { id: "sess-rs21" },
			user: {
				id: "rs21",
				name: "rs21",
				email: "rs21@example.com",
				isSuperuser: false,
				mustChangePassword: true,
				twoFactorEnabled: false,
			},
		});

		// The request that finally submits a new password still sees the flag set — it clears only
		// once the action's own body runs — so this is the request that has to do the stamping.
		await expect(requireSession()).rejects.toThrow("REDIRECT:/set-password");

		// The flag clears, the way `changePassword`'s own action leaves it.
		getSession.mockResolvedValue({
			session: { id: "sess-rs21" },
			user: {
				id: "rs21",
				name: "rs21",
				email: "rs21@example.com",
				isSuperuser: false,
				mustChangePassword: false,
				twoFactorEnabled: false,
			},
		});

		// Without the stamp above, this would still be measured against the original 40-minute-old
		// `lastSeenAt` and end the session instead of letting it through.
		await expect(requireSession()).resolves.toMatchObject({ id: "rs21" });
	});
});
