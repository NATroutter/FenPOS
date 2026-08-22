import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminPassword } from "@/lib/auth/admin";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Tests for the "choose a password" action — specifically that it enforces the *configured*
 * `auth.minimumPasswordLength`, not just the built-in floor `passwordSchema` defaults to
 * elsewhere. A regression here looks like nothing: the panel would advertise a raised minimum
 * while this action quietly kept accepting the old, shorter one — exactly the divergence this
 * setting exists to prevent.
 *
 * `getCurrentSession`, `getClientAddress`/`getUserAgent`, and `redirect` are all mocked because
 * they read a real Next.js request or throw the framework's own redirect signal — neither works
 * outside a request. `isPasswordGenerated` is not mocked — `ensureAdminPassword()` below makes it
 * true for real, against the actual database, which is less to keep in sync than a second mock
 * would be.
 *
 * The point of mocking every step *after* validation, rather than stopping at the session guard,
 * is that a reverted call site (`passwordSchema(12)` instead of the configured minimum) must fail
 * on the assertion below, not on some unrelated dependency the test happened not to mock — a
 * password that clears the built-in floor of 12 would otherwise run past validation and crash on
 * the first un-mocked call instead of producing a clean, legible test failure.
 */
vi.mock("@/lib/auth/session-cookie", () => ({
	getCurrentSession: async () => ({ id: "test-session", ipAddress: "127.0.0.1", userAgent: null }),
	setSessionCookie: async () => {},
}));

vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "127.0.0.1",
	getUserAgent: async () => null,
}));

// The real `redirect` signals success by throwing; a plain thrown error does the same job here
// without needing Next's router, and still fails this test loudly if the code path ever reaches it.
vi.mock("next/navigation", () => ({
	redirect: (url: string) => {
		throw new Error(`redirected to ${url}`);
	},
}));

const { setPassword } = await import("@/app/(auth)/set-password/actions");

function formData(password: string, confirm: string): FormData {
	const data = new FormData();
	data.set("password", password);
	data.set("confirm", confirm);
	return data;
}

beforeEach(async () => {
	await prisma.session.deleteMany({});
	await prisma.adminAuth.deleteMany({});
	await prisma.setting.deleteMany({});
	await ensureAdminPassword();
});

describe("setPassword", () => {
	it("refuses a password that satisfies the built-in floor but not the configured minimum", async () => {
		// Long enough for the built-in floor (12) but short of a minimum raised to 20. Reverting
		// the call site to a literal `passwordSchema(12)` must make this test fail.
		await setSetting("auth.minimumPasswordLength", 20);

		const result = await setPassword({ error: null }, formData("a".repeat(16), "a".repeat(16)));

		expect(result.error).not.toBeNull();
	});
});
