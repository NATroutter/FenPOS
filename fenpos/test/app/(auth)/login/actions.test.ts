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
const { prisma } = await import("@/lib/db");
const { setSetting } = await import("@/lib/settings/settings-service");

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		data.set(key, value);
	}
	return data;
}

describe("signIn", () => {
	beforeEach(async () => {
		signInLimiter.reset("203.0.113.30");
		signInEmail.mockReset();
		await prisma.setting.deleteMany({});
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
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

/**
 * The two gates that run before any credential is examined.
 *
 * Both refuse with the *same* message a wrong password gets. That is the property worth pinning: an
 * allowlist or a lockout that announced itself would tell an attacker they had found a real install,
 * or a real account, and hand them a way to enumerate either.
 */
describe("the gates before the credential", () => {
	/** A fresh account, returning the address to sign in with. Ids are per-case. */
	async function account(id: string): Promise<string> {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com` } });
		return `${id}@example.com`;
	}

	beforeEach(async () => {
		signInLimiter.reset("203.0.113.30");
		signInEmail.mockReset();
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
	});

	describe("address allowlist", () => {
		it("refuses an address that is not on it, without examining the credential", async () => {
			signInEmail.mockResolvedValue({ user: { id: "u1" } });
			await setSetting("auth.ipAllowlist", "10.0.0.0/8");

			const result = await signIn({ error: null }, form({ email: "known@example.com", password: "correct" }));

			expect(result.error).not.toBeNull();
			// Refused before the password is even looked at, so a barred address cannot be used to test
			// passwords either.
			expect(signInEmail).not.toHaveBeenCalled();
		});

		it("gives a barred address the same message a wrong password gets", async () => {
			signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));
			const wrongPassword = await signIn({ error: null }, form({ email: "known@example.com", password: "nope" }));

			signInLimiter.reset("203.0.113.30");
			await setSetting("auth.ipAllowlist", "10.0.0.0/8");
			const barred = await signIn({ error: null }, form({ email: "known@example.com", password: "correct" }));

			expect(barred.error).toBe(wrongPassword.error);
		});

		it("records the refusal so the record says what happened", async () => {
			await setSetting("auth.ipAllowlist", "10.0.0.0/8");

			await signIn({ error: null }, form({ email: "known@example.com", password: "correct" }));

			const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
			expect(row.outcome).toBe("DENIED");
			expect(row.detail).toContain("address-not-allowed");
		});

		it("allows an address on it", async () => {
			signInEmail.mockResolvedValue({ user: { id: "u1" } });
			// 203.0.113.30 is what the request-context mock above returns.
			await setSetting("auth.ipAllowlist", "203.0.113.0/24");

			await expect(signIn({ error: null }, form({ email: "known@example.com", password: "correct" }))).rejects.toThrow(
				"REDIRECT:/dashboard",
			);
		});

		it("allows every address while it is empty", async () => {
			signInEmail.mockResolvedValue({ user: { id: "u1" } });

			await expect(signIn({ error: null }, form({ email: "known@example.com", password: "correct" }))).rejects.toThrow(
				"REDIRECT:/dashboard",
			);
		});
	});

	describe("account lockout", () => {
		it("counts a wrong password toward the lock", async () => {
			await setSetting("auth.lockoutAfterFailures", 2);
			const email = await account("li1");
			signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

			await signIn({ error: null }, form({ email, password: "wrong" }));
			signInLimiter.reset("203.0.113.30");
			await signIn({ error: null }, form({ email, password: "wrong" }));

			const user = await prisma.user.findUniqueOrThrow({ where: { id: "li1" } });
			expect(user.lockedUntil).not.toBeNull();
		});

		it("refuses a locked account without examining the credential", async () => {
			await setSetting("auth.lockoutAfterFailures", 2);
			const email = await account("li2");
			await prisma.user.update({ where: { id: "li2" }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
			signInEmail.mockResolvedValue({ user: { id: "li2" } });

			const result = await signIn({ error: null }, form({ email, password: "correct" }));

			expect(result.error).not.toBeNull();
			expect(signInEmail).not.toHaveBeenCalled();
		});

		it("records a locked refusal as such", async () => {
			await setSetting("auth.lockoutAfterFailures", 2);
			const email = await account("li3");
			await prisma.user.update({ where: { id: "li3" }, data: { lockedUntil: new Date(Date.now() + 60_000) } });

			await signIn({ error: null }, form({ email, password: "correct" }));

			const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
			expect(row.detail).toContain("locked");
		});

		it("forgets the failures once a sign-in succeeds", async () => {
			await setSetting("auth.lockoutAfterFailures", 5);
			const email = await account("li4");
			signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));
			await signIn({ error: null }, form({ email, password: "wrong" }));
			signInLimiter.reset("203.0.113.30");

			signInEmail.mockReset();
			signInEmail.mockResolvedValue({ user: { id: "li4" } });
			await expect(signIn({ error: null }, form({ email, password: "correct" }))).rejects.toThrow(
				"REDIRECT:/dashboard",
			);

			const user = await prisma.user.findUniqueOrThrow({ where: { id: "li4" } });
			expect(user.failedSignInCount).toBe(0);
		});

		it("counts nothing while the setting is zero", async () => {
			const email = await account("li5");
			signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

			await signIn({ error: null }, form({ email, password: "wrong" }));

			const user = await prisma.user.findUniqueOrThrow({ where: { id: "li5" } });
			expect(user.failedSignInCount).toBe(0);
			expect(user.lockedUntil).toBeNull();
		});
	});
});
