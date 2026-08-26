import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelUser } from "@/lib/auth/require-session";

/**
 * The enrolment gate page, and the one redirect it must *not* make.
 *
 * Confirming an enrolment writes a new session cookie, and Next re-renders the current route before
 * replying — this route, now seeing `twoFactorEnabled` true. While the page redirected on that flag,
 * the render unmounted `TwoFactorPanel` and took the recovery codes with it, which are shown once in
 * an account's lifetime and stored encrypted thereafter. The page cannot tell that render apart from
 * a fresh visit, so it must not redirect on the flag at all.
 *
 * Asserted against what the page returns rather than against pixels: this suite runs in Node, and
 * the property is a routing decision, not a layout.
 */
const redirected = vi.fn((destination: string) => {
	throw new Error(`REDIRECT:${destination}`);
});
vi.mock("next/navigation", () => ({ redirect: redirected, useRouter: () => ({ push: vi.fn() }) }));

const currentUser = vi.fn<() => Promise<PanelUser | null>>();
vi.mock("@/lib/auth/require-session", () => ({ currentUser: () => currentUser() }));

const { default: EnrolTwoFactorPage } = await import("@/app/(auth)/enrol-2fa/page");
const { prisma } = await import("@/lib/db");
const { setSetting } = await import("@/lib/settings/settings-service");

/** The signed-in operator this page is rendered for. */
function operator(overrides: Partial<PanelUser> = {}): PanelUser {
	return {
		id: "gate-user",
		name: "Gate User",
		email: "gate@example.test",
		isSuperuser: false,
		mustChangePassword: false,
		sessionId: "gate-session",
		twoFactorEnabled: false,
		...overrides,
	};
}

describe("/enrol-2fa", () => {
	beforeEach(async () => {
		redirected.mockClear();
		await prisma.setting.deleteMany({});
		await setSetting("auth.require2fa", true);
		currentUser.mockReset().mockResolvedValue(operator());
	});

	it("renders the enrolment flow for an account with no authenticator", async () => {
		await expect(EnrolTwoFactorPage()).resolves.toBeTruthy();
		expect(redirected).not.toHaveBeenCalled();
	});

	it("holds an account that has just enrolled, so its recovery codes stay on the screen", async () => {
		currentUser.mockResolvedValue(operator({ twoFactorEnabled: true }));

		await expect(EnrolTwoFactorPage()).resolves.toBeTruthy();
		expect(redirected).not.toHaveBeenCalled();
	});

	it("sends a visitor away when the install does not require a second factor", async () => {
		await setSetting("auth.require2fa", false);

		await expect(EnrolTwoFactorPage()).rejects.toThrow("REDIRECT:/dashboard");
	});

	it("sends an account owing a password change to the page that takes it", async () => {
		currentUser.mockResolvedValue(operator({ mustChangePassword: true }));

		await expect(EnrolTwoFactorPage()).rejects.toThrow("REDIRECT:/set-password");
	});

	it("sends an unauthenticated visitor to sign in", async () => {
		currentUser.mockResolvedValue(null);

		await expect(EnrolTwoFactorPage()).rejects.toThrow("REDIRECT:/login");
	});
});
