import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialAccountRow } from "@/lib/auth/credential-account";
import { hashPassword } from "@/lib/auth/password";
import { headersMock, signedInUser } from "@/test/helpers/session";

/**
 * Replacing a password the account is required to change.
 *
 * The gate this defends is `mustChangePassword`: a session that owes a change reaches nothing but
 * this action, and this action must refuse anyone who does not owe one — otherwise it becomes a
 * way to change a password without knowing the current one, which is what the Settings form is
 * for and why that one asks.
 */
vi.mock("next/navigation", () => ({
	redirect: (destination: string) => {
		throw new Error(`REDIRECT:${destination}`);
	},
}));
vi.mock("next/headers", () => ({ headers: () => headersMock() }));

const user = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({ currentUser: () => user() }));

const { setPassword } = await import("@/app/(auth)/set-password/actions");
const { prisma } = await import("@/lib/db");
const actualAuth = await vi.importActual<typeof import("@/lib/auth/auth")>("@/lib/auth/auth");

function form(password: string, confirm: string): FormData {
	const data = new FormData();
	data.set("password", password);
	data.set("confirm", confirm);
	return data;
}

describe("setPassword", () => {
	beforeEach(async () => {
		user.mockReset();
		headersMock.mockReset().mockResolvedValue(new Headers());
		await prisma.user.deleteMany({});
	});

	it("sends an unauthenticated caller to sign-in", async () => {
		user.mockResolvedValue(null);

		await expect(setPassword({ error: null }, form("a-long-password", "a-long-password"))).rejects.toThrow(
			"REDIRECT:/login",
		);
	});

	it("sends a caller who owes no change to the dashboard", async () => {
		user.mockResolvedValue({
			id: "u1",
			name: "A",
			email: "a@example.com",
			isSuperuser: false,
			mustChangePassword: false,
		});

		const updateSpy = vi.spyOn(prisma.account, "updateMany");
		await expect(setPassword({ error: null }, form("a-long-password", "a-long-password"))).rejects.toThrow(
			"REDIRECT:/dashboard",
		);
		expect(updateSpy).not.toHaveBeenCalled();
		updateSpy.mockRestore();
	});

	it("refuses a mismatched confirmation", async () => {
		user.mockResolvedValue({
			id: "u1",
			name: "A",
			email: "a@example.com",
			isSuperuser: false,
			mustChangePassword: true,
		});

		const updateSpy = vi.spyOn(prisma.account, "updateMany");
		const result = await setPassword({ error: null }, form("a-long-password", "a-different-password"));

		expect(result.error).toMatch(/do not match/i);
		expect(updateSpy).not.toHaveBeenCalled();
		updateSpy.mockRestore();
	});

	it("returns an error rather than succeeding silently when the account has no credential", async () => {
		// A `User` row with no `Account` row at all: `prisma.account.updateMany`'s count is 0, the same
		// shape `setAccountPassword` and `lib/auth/recover.ts`'s `resetPassword` both refuse on.
		await prisma.user.create({
			data: { id: "u1", name: "A", email: "a@example.com", mustChangePassword: true, updatedAt: new Date() },
		});
		user.mockResolvedValue({
			id: "u1",
			name: "A",
			email: "a@example.com",
			isSuperuser: false,
			mustChangePassword: true,
		});

		const result = await setPassword({ error: null }, form("a-long-password", "a-long-password"));

		expect(result.error).toMatch(/no password to replace/i);
		expect((await prisma.user.findUnique({ where: { id: "u1" } }))?.mustChangePassword).toBe(true);
	});

	it("clears the flag and redirects on success", async () => {
		const now = new Date();
		await prisma.user.create({
			data: { id: "u1", name: "A", email: "a@example.com", mustChangePassword: true, updatedAt: now },
		});
		await prisma.account.create({
			data: credentialAccountRow("u1", await hashPassword("the-original-long-password"), now),
		});
		user.mockResolvedValue({
			id: "u1",
			name: "A",
			email: "a@example.com",
			isSuperuser: false,
			mustChangePassword: true,
		});

		await expect(setPassword({ error: null }, form("a-long-password", "a-long-password"))).rejects.toThrow(
			"REDIRECT:/dashboard",
		);

		expect((await prisma.user.findUnique({ where: { id: "u1" } }))?.mustChangePassword).toBe(false);
	});

	/**
	 * Drives the real action against a user who — unlike every fixture above — has an actual
	 * credential `account` row, created and signed in through Better Auth itself the way
	 * `setup.ts`/`account-service.ts` create one. This proves the direct credential write actually
	 * replaces the password Better Auth checks at sign-in, not just a row that merely exists.
	 */
	it("changes a real credential password, not just a mocked one", async () => {
		const email = "reset-me@example.com";
		const oldPassword = "the-original-long-password";
		const newPassword = "a-brand-new-long-password";

		const { user: created } = await signedInUser(email, oldPassword);
		await prisma.user.update({ where: { id: created.id }, data: { mustChangePassword: true } });

		user.mockResolvedValue({
			id: created.id,
			name: created.name,
			email,
			isSuperuser: false,
			mustChangePassword: true,
		});

		await expect(setPassword({ error: null }, form(newPassword, newPassword))).rejects.toThrow("REDIRECT:/dashboard");

		expect((await prisma.user.findUnique({ where: { id: created.id } }))?.mustChangePassword).toBe(false);

		// The old password no longer works and the new one does — the only proof that actually
		// matters, since a stored-hash comparison would pass even against a hash written through a
		// code path other than the one this test exists to cover.
		await expect(actualAuth.auth.api.signInEmail({ body: { email, password: oldPassword } })).rejects.toThrow();
		const resignedIn = await actualAuth.auth.api.signInEmail({ body: { email, password: newPassword } });
		expect(resignedIn.user.email).toBe(email);
	});

	/**
	 * **The regression test for the finding this branch exists to fix.** Every fixture above this
	 * one, and every fixture `signedInUser` produced before it grew a `role` parameter, creates an
	 * account with role `"admin"` — which is exactly why a suite full of real, unmocked calls to this
	 * action could still pass against code that called `auth.api.setUserPassword`: that endpoint is
	 * gated on the caller's session role against better-auth's admin plugin's `adminRoles` (default
	 * `["admin"]`), and every account above happened to hold that role. `account-service.ts` makes
	 * `"user"` the default role for every panel-made account, so this is the account shape the vast
	 * majority of real "Require password reset" flows actually have. Signed in as a `"user"`-role
	 * account with `mustChangePassword` forced, this must still be able to complete the change —
	 * proving the action does not depend on the caller already holding better-auth's admin role.
	 */
	it("lets a non-admin account complete a forced password change", async () => {
		const email = "non-admin@example.com";
		const oldPassword = "the-original-long-password";
		const newPassword = "a-brand-new-long-password";

		const { user: created } = await signedInUser(email, oldPassword, "user");
		await prisma.user.update({ where: { id: created.id }, data: { mustChangePassword: true } });

		user.mockResolvedValue({
			id: created.id,
			name: created.name,
			email,
			isSuperuser: false,
			mustChangePassword: true,
		});

		await expect(setPassword({ error: null }, form(newPassword, newPassword))).rejects.toThrow("REDIRECT:/dashboard");

		expect((await prisma.user.findUnique({ where: { id: created.id } }))?.mustChangePassword).toBe(false);

		await expect(actualAuth.auth.api.signInEmail({ body: { email, password: oldPassword } })).rejects.toThrow();
		const resignedIn = await actualAuth.auth.api.signInEmail({ body: { email, password: newPassword } });
		expect(resignedIn.user.email).toBe(email);
	});
});
