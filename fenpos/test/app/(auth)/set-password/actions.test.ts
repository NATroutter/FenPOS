import { beforeEach, describe, expect, it, vi } from "vitest";

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

const headersMock = vi.fn(async () => new Headers());
vi.mock("next/headers", () => ({ headers: () => headersMock() }));

const user = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({ currentUser: () => user() }));

const setUserPasswordApi = vi.fn();
vi.mock("@/lib/auth/auth", () => ({
	auth: { api: { setUserPassword: (args: unknown) => setUserPasswordApi(args) } },
}));

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
		setUserPasswordApi.mockReset().mockResolvedValue({});
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

		await expect(setPassword({ error: null }, form("a-long-password", "a-long-password"))).rejects.toThrow(
			"REDIRECT:/dashboard",
		);
		expect(setUserPasswordApi).not.toHaveBeenCalled();
	});

	it("refuses a mismatched confirmation", async () => {
		user.mockResolvedValue({
			id: "u1",
			name: "A",
			email: "a@example.com",
			isSuperuser: false,
			mustChangePassword: true,
		});

		const result = await setPassword({ error: null }, form("a-long-password", "a-different-password"));

		expect(result.error).toMatch(/do not match/i);
		expect(setUserPasswordApi).not.toHaveBeenCalled();
	});

	it("clears the flag and redirects on success", async () => {
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

		await expect(setPassword({ error: null }, form("a-long-password", "a-long-password"))).rejects.toThrow(
			"REDIRECT:/dashboard",
		);

		expect(setUserPasswordApi).toHaveBeenCalled();
		expect((await prisma.user.findUnique({ where: { id: "u1" } }))?.mustChangePassword).toBe(false);
	});

	/**
	 * Drives the real `auth.api.setUserPassword`, against a user who — unlike every fixture above —
	 * has an actual credential `account` row. Every mocked test in this file would pass even if the
	 * action still called the wrong endpoint, because the mock never runs Better Auth's own
	 * `PASSWORD_ALREADY_SET` branch. This test creates the account the way `setup.ts` does (a
	 * credential row present from the start), forces a password change on it, drives the action for
	 * real, and proves the stored password actually changed by signing in with the new one.
	 */
	it("changes a real credential password, not just a mocked one", async () => {
		const email = "reset-me@example.com";
		const oldPassword = "the-original-long-password";
		const newPassword = "a-brand-new-long-password";

		const created = await actualAuth.auth.api.createUser({
			body: { email, password: oldPassword, name: "Reset Me", role: "admin" },
		});
		await prisma.user.update({ where: { id: created.user.id }, data: { mustChangePassword: true } });

		const signedIn = await actualAuth.auth.api.signInEmail({
			body: { email, password: oldPassword },
			returnHeaders: true,
		});
		const cookie = signedIn.headers
			.getSetCookie()
			.map((entry) => entry.split(";")[0])
			.join("; ");

		user.mockResolvedValue({
			id: created.user.id,
			name: "Reset Me",
			email,
			isSuperuser: false,
			mustChangePassword: true,
		});
		headersMock.mockResolvedValue(new Headers({ cookie }));
		setUserPasswordApi.mockImplementation((args: Parameters<typeof actualAuth.auth.api.setUserPassword>[0]) =>
			actualAuth.auth.api.setUserPassword(args),
		);

		await expect(setPassword({ error: null }, form(newPassword, newPassword))).rejects.toThrow("REDIRECT:/dashboard");

		expect((await prisma.user.findUnique({ where: { id: created.user.id } }))?.mustChangePassword).toBe(false);

		// The old password no longer works and the new one does — the only proof that actually
		// matters, since a stored-hash comparison would pass even against a hash Better Auth wrote
		// through a code path other than the one this test exists to cover.
		await expect(actualAuth.auth.api.signInEmail({ body: { email, password: oldPassword } })).rejects.toThrow();
		const resignedIn = await actualAuth.auth.api.signInEmail({ body: { email, password: newPassword } });
		expect(resignedIn.user.email).toBe(email);
	});
});
