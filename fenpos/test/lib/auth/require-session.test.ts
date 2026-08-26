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
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

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

const { currentUser, requireSession } = await import("@/lib/auth/require-session");
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
