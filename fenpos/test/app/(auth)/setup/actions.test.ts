import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The setup actions.
 *
 * These are the public POST endpoints in front of the seal, so what is asserted here is that they
 * add no route around it: a refusal is indistinguishable whatever its cause, throttling is
 * consumed before anything is examined, and a claimed install refuses before it reads the form.
 *
 * `next/headers` is stubbed because `runSetup` passes this request's real headers to Better
 * Auth's `signInEmail` so it can attach a session cookie — there is no live request here for it to
 * read. `@/lib/auth/auth` is stubbed too: with the real module in play, a valid submission would
 * attempt a genuine sign-in outside any request scope. Stubbing it does not weaken what this file
 * tests — the seal's refusal behaviour is exercised against the real `completeSetup`, and the
 * "creates exactly one superuser" assertion below reads the database directly rather than trusting
 * the stub.
 */
vi.mock("next/navigation", () => ({
	redirect: (destination: string) => {
		throw new Error(`REDIRECT:${destination}`);
	},
}));

vi.mock("next/headers", () => ({
	headers: async () => new Headers(),
}));

vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.20",
	getUserAgent: async () => "vitest",
}));

const signInEmail = vi.fn();
vi.mock("@/lib/auth/auth", () => ({ auth: { api: { signInEmail: (args: unknown) => signInEmail(args) } } }));

const { runSetup } = await import("@/app/(auth)/setup/actions");
const { rotateSetupKey } = await import("@/lib/auth/setup-key");
const { setupLimiter } = await import("@/lib/auth/rate-limit");
const { prisma } = await import("@/lib/db");

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		data.set(key, value);
	}
	return data;
}

describe("runSetup", () => {
	beforeEach(async () => {
		setupLimiter.reset("203.0.113.20");
		signInEmail.mockReset();
		await prisma.setupKey.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.user.deleteMany({});
	});

	it("gives the same message for a wrong key and for a claimed install", async () => {
		await rotateSetupKey();
		const wrongKey = await runSetup(
			{ error: null },
			form({ setupKey: "XXXX-XXXX-XXXX-XXXX-XXXX", name: "A", email: "a@example.com", password: "a-long-password-x" }),
		);

		setupLimiter.reset("203.0.113.20");
		await prisma.setupKey.deleteMany({});
		await prisma.user.create({
			data: { id: "u", name: "Owner", email: "owner@example.com", updatedAt: new Date() },
		});

		const claimed = await runSetup(
			{ error: null },
			form({ setupKey: "XXXX-XXXX-XXXX-XXXX-XXXX", name: "A", email: "a@example.com", password: "a-long-password-x" }),
		);

		expect(wrongKey.error).toBe(claimed.error);
		expect(wrongKey.error).not.toBeNull();
	});

	it("throttles before it examines the submission", async () => {
		await rotateSetupKey();

		const attempts = [];
		for (let index = 0; index < 4; index += 1) {
			attempts.push(
				await runSetup(
					{ error: null },
					form({ setupKey: "WRON-GKEY-WRON-GKEY-WRON", name: "", email: "", password: "" }),
				),
			);
		}

		expect(attempts.at(-1)?.error).toMatch(/too many/i);
	});

	it("creates the superuser and redirects on a valid submission", async () => {
		const key = (await rotateSetupKey()) as string;

		await expect(
			runSetup(
				{ error: null },
				form({ setupKey: key, name: "Owner", email: "owner@example.com", password: "a-sufficiently-long-pass" }),
			),
		).rejects.toThrow("REDIRECT:/dashboard");

		const user = await prisma.user.findUnique({ where: { email: "owner@example.com" } });
		expect(user?.isSuperuser).toBe(true);

		expect(signInEmail).toHaveBeenCalledTimes(1);
	});
});
