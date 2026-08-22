import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DISPLAY_NAME, getAdminProfile, setAdminPassword, verifyAdminPassword } from "@/lib/auth/admin";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Tests for the profile action.
 *
 * The session guard redirects, and a redirect is not what this file is about; everything
 * downstream of it is the real validation against the real database.
 */
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => {},
}));

// Revalidation is Next's, not this project's, and calling it outside a request context throws.
// Kept as a `vi.fn()` (not a no-op) so the default-argument tests below can assert what path
// each action actually revalidates.
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const { changePassword, updateProfile } = await import("@/app/(panel)/settings/actions");

beforeEach(async () => {
	await prisma.session.deleteMany({});
	await prisma.adminAuth.deleteMany({});
	// So a minimum raised by one test cannot leak into the next — the settings table is one
	// file per worker process (test/setup-database.ts), not reset between test files.
	await prisma.setting.deleteMany({ where: { key: "auth.minimumPasswordLength" } });
	await setAdminPassword("correct horse battery staple");
	revalidatePath.mockClear();
});

describe("run's default revalidation", () => {
	/**
	 * Neither action passes a third argument to `run`, so both rely on its default. Pinning both
	 * branches here means a change to that default cannot silently stop revalidating what an
	 * existing caller depends on.
	 */
	it("revalidates /settings for an action that passes no revalidate argument", async () => {
		const result = await changePassword("correct horse battery staple", "a new correct password");

		expect(result.error).toBeNull();
		expect(revalidatePath).toHaveBeenCalledWith("/settings");
	});

	it("still revalidates the layout for updateProfile, which passes its own revalidate argument", async () => {
		const result = await updateProfile("NATroutter", "me@natroutter.fi");

		expect(result.error).toBeNull();
		expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
	});
});

/**
 * `changePassword` must honour the *configured* `auth.minimumPasswordLength`, not the built-in
 * floor `passwordSchema` defaults to elsewhere. Reverting the call site to a literal
 * `passwordSchema(12)` — the built-in floor — must make this test fail: a 16-character password
 * satisfies that floor, so only actually reading the setting refuses it.
 */
describe("changePassword with a configured minimum", () => {
	it("refuses a new password that satisfies the built-in floor but not a raised configured minimum", async () => {
		await setSetting("auth.minimumPasswordLength", 20);

		const result = await changePassword("correct horse battery staple", "a".repeat(16));

		expect(result.error).not.toBeNull();
		await expect(verifyAdminPassword("correct horse battery staple")).resolves.toBe(true);
	});
});

describe("updateProfile", () => {
	it("stores a name and an email", async () => {
		const result = await updateProfile("NATroutter", "me@natroutter.fi");

		expect(result.error).toBeNull();
		await expect(getAdminProfile()).resolves.toEqual({ displayName: "NATroutter", email: "me@natroutter.fi" });
	});

	it("trims what it stores, so a stray space cannot change the avatar", async () => {
		await updateProfile("  NATroutter  ", "  me@natroutter.fi  ");

		await expect(getAdminProfile()).resolves.toEqual({ displayName: "NATroutter", email: "me@natroutter.fi" });
	});

	/** An empty field is how an operator removes an address, and it must reach the column as null. */
	it("turns an empty email into null", async () => {
		await updateProfile("NATroutter", "");

		await expect(getAdminProfile()).resolves.toEqual({ displayName: "NATroutter", email: null });
	});

	it("accepts a null email", async () => {
		await updateProfile("NATroutter", null);

		await expect(getAdminProfile()).resolves.toEqual({ displayName: "NATroutter", email: null });
	});

	it("refuses an empty display name, since the footer and the initial are drawn from it", async () => {
		const result = await updateProfile("   ", null);

		expect(result.error).not.toBeNull();
		await expect(getAdminProfile()).resolves.toMatchObject({ displayName: DEFAULT_DISPLAY_NAME });
	});

	it("refuses a display name over 60 characters", async () => {
		const result = await updateProfile("x".repeat(61), null);

		expect(result.error).not.toBeNull();
	});

	it("accepts a display name of exactly 60 characters", async () => {
		const result = await updateProfile("x".repeat(60), null);

		expect(result.error).toBeNull();
	});

	it("refuses a malformed email and stores nothing", async () => {
		const result = await updateProfile("NATroutter", "not-an-address");

		expect(result.error).not.toBeNull();
		await expect(getAdminProfile()).resolves.toEqual({ displayName: DEFAULT_DISPLAY_NAME, email: null });
	});

	/** The two forms are edited separately and neither may be a side effect of the other. */
	it("leaves the password alone", async () => {
		const { verifyAdminPassword } = await import("@/lib/auth/admin");
		await updateProfile("NATroutter", "me@natroutter.fi");

		await expect(verifyAdminPassword("correct horse battery staple")).resolves.toBe(true);
	});
});
