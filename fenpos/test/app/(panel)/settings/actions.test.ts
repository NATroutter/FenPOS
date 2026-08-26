import { beforeEach, describe, expect, it, vi } from "vitest";
import { headersMock, signedInUser } from "@/test/helpers/session";

/**
 * Tests for the profile, password and two-factor actions behind the Settings tab.
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
 *
 * The two-factor actions go through Better Auth's own `enableTwoFactor`/`verifyTOTP` for real —
 * `changePassword` is the only method still stubbed, so the mock factory merges the real `auth.api`
 * in rather than replacing it. `startTwoFactor`, `confirmTwoFactor` and `stopTwoFactor` call
 * `lib/auth/two-factor.ts`, which resolves its caller from the session cookie via `headers()`, not
 * from the stubbed `requireSession` — so those tests use `signedInUser` to sign a real account in
 * and point the shared `headersMock` at its session, the same helper `set-password/actions.test.ts`
 * uses for the same reason.
 */
vi.mock("next/headers", () => ({ headers: () => headersMock() }));

const changePasswordApi = vi.fn();
vi.mock("@/lib/auth/auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/auth/auth")>();
	return {
		auth: { ...actual.auth, api: { ...actual.auth.api, changePassword: (args: unknown) => changePasswordApi(args) } },
	};
});

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

const { changePassword, updateProfile, startTwoFactor, confirmTwoFactor } = await import(
	"@/app/(panel)/settings/actions"
);
const { prisma } = await import("@/lib/db");
const { setSetting } = await import("@/lib/settings/settings-service");

beforeEach(async () => {
	changePasswordApi.mockReset().mockResolvedValue({ token: null, user: SESSION_USER });
	revalidatePath.mockClear();
	// Reset to the file's default of "no session cookie" between tests — a two-factor test that ran
	// before this one may have pointed it at a real account's cookie via `signedInUser`.
	headersMock.mockReset().mockResolvedValue(new Headers());

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

describe("two-factor actions", () => {
	it("refuses to start enrolment without the current password", async () => {
		await signedInUser("tfa-start@example.test", "correct horse battery staple");
		const result = await startTwoFactor("wrong password");
		expect(result.error).not.toBeNull();
		expect(result.enrolment).toBeNull();
	});

	it("hands back an enrolment and writes a row for it", async () => {
		await signedInUser("tfa-ok@example.test", "correct horse battery staple");
		const result = await startTwoFactor("correct horse battery staple");
		expect(result.enrolment?.qrSvg.startsWith("<svg")).toBe(true);

		const row = await prisma.auditEvent.findFirst({ orderBy: { seq: "desc" } });
		expect(row?.action).toBe("self:begin-2fa");
		expect(row?.outcome).toBe("SUCCESS");
	});

	it("never puts the secret or the recovery codes in the audit row", async () => {
		await signedInUser("tfa-quiet@example.test", "correct horse battery staple");
		const result = await startTwoFactor("correct horse battery staple");
		const secret = new URL(result.enrolment?.totpUri ?? "otpauth://x").searchParams.get("secret") ?? "";

		const row = await prisma.auditEvent.findFirst({ orderBy: { seq: "desc" } });
		const serialised = JSON.stringify(row);
		expect(serialised).not.toContain(secret);
		for (const code of result.enrolment?.recoveryCodes ?? []) {
			expect(serialised).not.toContain(code);
		}
	});

	it("records a refused confirmation as DENIED, not as a success", async () => {
		await signedInUser("tfa-bad@example.test", "correct horse battery staple");
		await startTwoFactor("correct horse battery staple");
		const result = await confirmTwoFactor("000000");
		expect(result.error).not.toBeNull();

		const row = await prisma.auditEvent.findFirst({ orderBy: { seq: "desc" } });
		expect(row?.action).toBe("self:confirm-2fa");
		expect(row?.outcome).toBe("FAILURE");
	});
});
