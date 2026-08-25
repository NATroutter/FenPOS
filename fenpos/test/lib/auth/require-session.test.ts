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

const getSession = vi.fn();
vi.mock("@/lib/auth/auth", () => ({ auth: { api: { getSession: () => getSession() } } }));

const claimed = vi.fn();
vi.mock("@/lib/auth/setup-key", () => ({ isInstallClaimed: () => claimed() }));

const { currentUser, requireSession } = await import("@/lib/auth/require-session");

describe("requireSession", () => {
	beforeEach(() => {
		redirected.mockClear();
		getSession.mockReset();
		claimed.mockReset().mockResolvedValue(true);
	});

	it("returns the signed-in user", async () => {
		getSession.mockResolvedValue({
			user: { id: "u1", name: "Owner", email: "owner@example.com", isSuperuser: true, mustChangePassword: false },
		});

		await expect(requireSession()).resolves.toEqual({
			id: "u1",
			name: "Owner",
			email: "owner@example.com",
			isSuperuser: true,
			mustChangePassword: false,
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
