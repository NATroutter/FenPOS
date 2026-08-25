import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sign-in.
 *
 * The property under test is that failures are indistinguishable: a wrong password, an unknown
 * address, a banned account and a malformed submission must all produce one message. Telling them
 * apart discloses which addresses hold accounts, which is useful only to someone who should not
 * be here.
 */
vi.mock("next/navigation", () => ({
	redirect: (destination: string) => {
		throw new Error(`REDIRECT:${destination}`);
	},
}));

// `signIn` passes this request's real headers to Better Auth's `signInEmail`, but there is no
// live request here for it to read — the same reason `runSetup`'s test stubs it.
vi.mock("next/headers", () => ({
	headers: async () => new Headers(),
}));

vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.30",
	getUserAgent: async () => "vitest",
}));

const signInEmail = vi.fn();
vi.mock("@/lib/auth/auth", () => ({ auth: { api: { signInEmail: (args: unknown) => signInEmail(args) } } }));

const { signIn } = await import("@/app/(auth)/login/actions");
const { signInLimiter } = await import("@/lib/auth/rate-limit");

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		data.set(key, value);
	}
	return data;
}

describe("signIn", () => {
	beforeEach(() => {
		signInLimiter.reset("203.0.113.30");
		signInEmail.mockReset();
	});

	it("gives one message for a wrong password and for an unknown address", async () => {
		signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

		const wrongPassword = await signIn({ error: null }, form({ email: "known@example.com", password: "nope" }));
		signInLimiter.reset("203.0.113.30");
		const unknownAddress = await signIn({ error: null }, form({ email: "nobody@example.com", password: "nope" }));

		expect(wrongPassword.error).toBe(unknownAddress.error);
		expect(wrongPassword.error).not.toBeNull();
	});

	it("gives the same message for a malformed submission", async () => {
		const malformed = await signIn({ error: null }, form({ email: "", password: "" }));
		expect(malformed.error).not.toBeNull();
		expect(signInEmail).not.toHaveBeenCalled();
	});

	it("redirects to the dashboard on success", async () => {
		signInEmail.mockResolvedValue({ user: { id: "u1" } });

		await expect(
			signIn({ error: null }, form({ email: "owner@example.com", password: "a-long-password" })),
		).rejects.toThrow("REDIRECT:/dashboard");
	});

	it("throttles before it examines the submission", async () => {
		signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

		const attempts = [];
		for (let index = 0; index < 6; index += 1) {
			attempts.push(await signIn({ error: null }, form({ email: "a@example.com", password: "x" })));
		}

		expect(attempts.at(-1)?.error).toMatch(/too many/i);
	});
});
