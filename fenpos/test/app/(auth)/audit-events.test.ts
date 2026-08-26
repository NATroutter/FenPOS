import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The events the auth surface leaves behind.
 *
 * Each assertion is one question an incident starts with: who tried to get in, from where, and was
 * it refused. A refused attempt matters more here than a successful one — a record that held only
 * successes would be one in which a night of guessing looks like silence.
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
	getClientAddress: async () => "203.0.113.40",
	getUserAgent: async () => "vitest",
}));

const signInEmail = vi.fn();
vi.mock("@/lib/auth/auth", () => ({ auth: { api: { signInEmail: (args: unknown) => signInEmail(args) } } }));

const { signIn } = await import("@/app/(auth)/login/actions");
const { checkSetupKey, runSetup } = await import("@/app/(auth)/setup/actions");
const { AUTH_AUDIT_ACTIONS } = await import("@/lib/audit/auth-events");
const { verifyAuditChain } = await import("@/lib/audit/verify");
const { rotateSetupKey } = await import("@/lib/auth/setup-key");
const { setupLimiter, signInLimiter } = await import("@/lib/auth/rate-limit");
const { prisma } = await import("@/lib/db");

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		data.set(key, value);
	}
	return data;
}

/** The most recent row, which is the one the action under test just wrote. */
async function lastEvent() {
	return prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
}

describe("auth audit events", () => {
	beforeEach(async () => {
		signInLimiter.reset("203.0.113.40");
		setupLimiter.reset("203.0.113.40");
		signInEmail.mockReset();
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
		await prisma.setupKey.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	it("records a refused sign-in with the address that was tried", async () => {
		signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

		await signIn({ error: null }, form({ email: "Stranger@Example.com", password: "wrong" }));

		const row = await lastEvent();
		expect(row.action).toBe(AUTH_AUDIT_ACTIONS.SIGN_IN);
		expect(row.outcome).toBe("DENIED");
		// Normalised the same way the credential check normalises it, so the row and the attempt
		// agree about what was tried.
		expect(row.actorEmail).toBe("stranger@example.com");
		expect(row.actorUserId).toBeNull();
		expect(row.ipAddress).toBe("203.0.113.40");
	});

	it("records a successful sign-in against the account that signed in", async () => {
		signInEmail.mockResolvedValue({ user: { id: "u1", name: "Owner", email: "owner@example.com" }, token: "tok-u1" });

		await expect(
			signIn({ error: null }, form({ email: "owner@example.com", password: "a-long-password" })),
		).rejects.toThrow("REDIRECT:/dashboard");

		const row = await lastEvent();
		expect(row.action).toBe(AUTH_AUDIT_ACTIONS.SIGN_IN);
		expect(row.outcome).toBe("SUCCESS");
		expect(row.actorUserId).toBe("u1");
	});

	it("records a throttled attempt rather than letting it pass unrecorded", async () => {
		signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

		for (let attempt = 0; attempt < 6; attempt++) {
			await signIn({ error: null }, form({ email: "a@example.com", password: "x" }));
		}

		const row = await lastEvent();
		expect(row.outcome).toBe("DENIED");
		expect(JSON.parse(row.detail as string)).toMatchObject({ reason: "rate-limited" });
	});

	it("records a refused setup key without recording the key", async () => {
		await rotateSetupKey();

		await checkSetupKey({ error: null }, form({ setupKey: "XXXX-XXXX-XXXX-XXXX-XXXX" }));

		const row = await lastEvent();
		expect(row.action).toBe(AUTH_AUDIT_ACTIONS.SETUP_KEY);
		expect(row.outcome).toBe("DENIED");
		expect(row.actorKind).toBe("SETUP");
		expect(JSON.stringify(row)).not.toContain("XXXX-XXXX");
	});

	it("writes no row when a setup key checks out", async () => {
		const key = (await rotateSetupKey()) as string;

		await checkSetupKey({ error: null }, form({ setupKey: key }));

		// Passing this action proves nothing and grants nothing; the real check is inside
		// `completeSetup`'s transaction. Recording the successes would bury the refusals.
		expect(await prisma.auditEvent.count()).toBe(0);
	});

	it("records the install being claimed", async () => {
		const key = (await rotateSetupKey()) as string;
		signInEmail.mockResolvedValue({ user: { id: "u1" } });

		await expect(
			runSetup(
				{ error: null },
				form({ setupKey: key, name: "Owner", email: "owner@example.com", password: "a-long-enough-password" }),
			),
		).rejects.toThrow("REDIRECT:/dashboard");

		const row = await prisma.auditEvent.findFirstOrThrow({ where: { action: AUTH_AUDIT_ACTIONS.SETUP_COMPLETE } });
		expect(row.outcome).toBe("SUCCESS");
		expect(row.actorKind).toBe("SETUP");
		expect(row.targetLabel).toBe("owner@example.com");
		expect(row.targetId).not.toBeNull();
	});

	it("keeps the chain intact across everything it wrote", async () => {
		await rotateSetupKey();
		signInEmail.mockRejectedValue(new Error("INVALID_EMAIL_OR_PASSWORD"));

		await signIn({ error: null }, form({ email: "a@example.com", password: "x" }));
		await checkSetupKey({ error: null }, form({ setupKey: "XXXX-XXXX-XXXX-XXXX-XXXX" }));
		await checkSetupKey({ error: null }, form({ setupKey: "YYYY-YYYY-YYYY-YYYY-YYYY" }));

		expect(await verifyAuditChain(prisma)).toMatchObject({ ok: true, checked: 3 });
	});
});
