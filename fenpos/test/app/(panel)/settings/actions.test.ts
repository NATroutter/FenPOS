import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the profile and password actions behind the Settings tab.
 *
 * The session guard redirects, and a redirect is not what this file is about, so `requireSession`
 * is stubbed to hand back a fixed user rather than exercised for real — the same convention the
 * other auth action tests in this codebase use (see `set-password/actions.test.ts`).
 *
 * `auth.api.changePassword` is stubbed too. Verifying the current password and enforcing its own
 * bounds on the new one are Better Auth's concern, proven by that library's own tests; what belongs
 * here is that this action reads the *configured* minimum before Better Auth ever sees the
 * candidate, and that a rejection from Better Auth surfaces as this action's own message.
 *
 * `updateProfile` writes through Prisma directly, so its tests exercise the real database rather
 * than a stub.
 */
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const changePasswordApi = vi.fn();
vi.mock("@/lib/auth/auth", () => ({
	auth: { api: { changePassword: (args: unknown) => changePasswordApi(args) } },
}));

const SESSION_USER = {
	id: "u1",
	name: "NATroutter",
	email: "me@natroutter.fi",
	isSuperuser: true,
	mustChangePassword: false,
};
vi.mock("@/lib/auth/require-session", () => ({ requireSession: async () => SESSION_USER }));

// Revalidation is Next's, not this project's, and calling it outside a request context throws.
// Kept as a `vi.fn()` (not a no-op) so the default-argument tests below can assert what path
// each action actually revalidates.
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const { changePassword, updateProfile } = await import("@/app/(panel)/settings/actions");
const { prisma } = await import("@/lib/db");
const { setSetting } = await import("@/lib/settings/settings-service");

beforeEach(async () => {
	changePasswordApi.mockReset().mockResolvedValue({ token: null, user: SESSION_USER });
	revalidatePath.mockClear();

	await prisma.session.deleteMany({});
	await prisma.user.deleteMany({});
	// So a minimum raised by one test cannot leak into the next — the settings table is one
	// file per worker process (test/setup-database.ts), not reset between test files.
	await prisma.setting.deleteMany({ where: { key: "auth.minimumPasswordLength" } });

	await prisma.user.create({
		data: { id: SESSION_USER.id, name: SESSION_USER.name, email: SESSION_USER.email, updatedAt: new Date() },
	});
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

describe("changePassword", () => {
	it("calls Better Auth with the current password, the new one, and revokeOtherSessions", async () => {
		const result = await changePassword("correct horse battery staple", "a new correct password");

		expect(result.error).toBeNull();
		expect(changePasswordApi).toHaveBeenCalledWith({
			body: {
				currentPassword: "correct horse battery staple",
				newPassword: "a new correct password",
				revokeOtherSessions: true,
			},
			headers: expect.any(Headers),
		});
	});

	it("surfaces a rejection from Better Auth as 'not the current password'", async () => {
		changePasswordApi.mockRejectedValue(new Error("INVALID_PASSWORD"));

		const result = await changePassword("wrong password entirely", "a new correct password");

		expect(result.error).toMatch(/not the current password/i);
	});

	/**
	 * `changePassword` must honour the *configured* `auth.minimumPasswordLength`, not the built-in
	 * floor `passwordSchema` defaults to elsewhere, and it must refuse before Better Auth — which
	 * knows nothing about this install's setting — ever sees the candidate. Reverting the call site
	 * to a literal `passwordSchema(12)` would make this test fail: a 16-character password satisfies
	 * that floor, so only actually reading the setting refuses it.
	 */
	it("refuses a new password that satisfies the built-in floor but not a raised configured minimum", async () => {
		await setSetting("auth.minimumPasswordLength", 20);

		const result = await changePassword("correct horse battery staple", "a".repeat(16));

		expect(result.error).not.toBeNull();
		expect(changePasswordApi).not.toHaveBeenCalled();
	});
});

describe("updateProfile", () => {
	it("stores a name and an email", async () => {
		const result = await updateProfile("New Name", "new@example.com");

		expect(result.error).toBeNull();
		await expect(prisma.user.findUnique({ where: { id: SESSION_USER.id } })).resolves.toMatchObject({
			name: "New Name",
			email: "new@example.com",
		});
	});

	it("trims what it stores, so a stray space cannot change the avatar", async () => {
		await updateProfile("  New Name  ", "  new@example.com  ");

		await expect(prisma.user.findUnique({ where: { id: SESSION_USER.id } })).resolves.toMatchObject({
			name: "New Name",
			email: "new@example.com",
		});
	});

	it("refuses an empty display name, since the footer and the initial are drawn from it", async () => {
		const result = await updateProfile("   ", SESSION_USER.email);

		expect(result.error).not.toBeNull();
		await expect(prisma.user.findUnique({ where: { id: SESSION_USER.id } })).resolves.toMatchObject({
			name: SESSION_USER.name,
		});
	});

	it("refuses a display name over 60 characters", async () => {
		const result = await updateProfile("x".repeat(61), SESSION_USER.email);

		expect(result.error).not.toBeNull();
	});

	it("accepts a display name of exactly 60 characters", async () => {
		const result = await updateProfile("x".repeat(60), SESSION_USER.email);

		expect(result.error).toBeNull();
	});

	/**
	 * Unlike the single-administrator model this replaced, an empty email is refused rather than
	 * turned into null: the `User` row's `email` column is required and unique, so there is no
	 * "no email set" state for a signed-in user to be in.
	 */
	it("refuses an empty email", async () => {
		const result = await updateProfile(SESSION_USER.name, "");

		expect(result.error).not.toBeNull();
		await expect(prisma.user.findUnique({ where: { id: SESSION_USER.id } })).resolves.toMatchObject({
			email: SESSION_USER.email,
		});
	});

	it("refuses a malformed email and stores nothing", async () => {
		const result = await updateProfile(SESSION_USER.name, "not-an-address");

		expect(result.error).not.toBeNull();
		await expect(prisma.user.findUnique({ where: { id: SESSION_USER.id } })).resolves.toMatchObject({
			email: SESSION_USER.email,
		});
	});

	/** The column's own unique constraint is what a second operator's simultaneous edit collides with. */
	it("refuses an email already in use by another account", async () => {
		await prisma.user.create({
			data: { id: "u2", name: "Someone Else", email: "taken@example.com", updatedAt: new Date() },
		});

		const result = await updateProfile(SESSION_USER.name, "taken@example.com");

		expect(result.error).toMatch(/already in use/i);
		await expect(prisma.user.findUnique({ where: { id: SESSION_USER.id } })).resolves.toMatchObject({
			email: SESSION_USER.email,
		});
	});

	/** The two forms are edited separately and neither may be a side effect of the other. */
	it("leaves the password alone", async () => {
		await updateProfile("New Name", "new@example.com");

		expect(changePasswordApi).not.toHaveBeenCalled();
	});
});
