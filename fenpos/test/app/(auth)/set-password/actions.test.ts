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

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const user = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({ currentUser: () => user() }));

const setPasswordApi = vi.fn();
vi.mock("@/lib/auth/auth", () => ({ auth: { api: { setPassword: (args: unknown) => setPasswordApi(args) } } }));

const { setPassword } = await import("@/app/(auth)/set-password/actions");
const { prisma } = await import("@/lib/db");

function form(password: string, confirm: string): FormData {
	const data = new FormData();
	data.set("password", password);
	data.set("confirm", confirm);
	return data;
}

describe("setPassword", () => {
	beforeEach(async () => {
		user.mockReset();
		setPasswordApi.mockReset().mockResolvedValue({});
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
		expect(setPasswordApi).not.toHaveBeenCalled();
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
		expect(setPasswordApi).not.toHaveBeenCalled();
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

		expect(setPasswordApi).toHaveBeenCalled();
		expect((await prisma.user.findUnique({ where: { id: "u1" } }))?.mustChangePassword).toBe(false);
	});
});
