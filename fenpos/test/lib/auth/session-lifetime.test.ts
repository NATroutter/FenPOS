import { beforeEach, describe, expect, it } from "vitest";
import { createAccount, type NewAccountInput } from "@/lib/auth/account-service";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Session lifetime comes from a setting, not from the module-load constant it used to be.
 *
 * Asserted against the stored row rather than against the returned token, because the row is what
 * the session gate reads on every subsequent request — a token that claimed one lifetime over a row
 * that held another would expire at whichever came first, silently.
 */
describe("session lifetime", () => {
	beforeEach(async () => {
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	/** A superuser to act as, which the guard functions treat as able to grant anything. */
	async function superuser(id: string) {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser: true } });
		return { id, isSuperuser: true };
	}

	/** An account created through the real service, so its credential row is the real shape. */
	async function createCredentialUser(email: string, password: string) {
		const actor = await superuser(`${email}-actor`);
		const input: NewAccountInput = {
			name: "Session Lifetime Test",
			email,
			password,
			requirePasswordReset: false,
			roleIds: [],
			permissions: [],
		};
		const { userId } = await createAccount(actor, input);
		return { id: userId };
	}

	it("expires a new session after the configured hours", async () => {
		await setSetting("auth.sessionHours", 3);
		const user = await createCredentialUser("lifetime@example.test", "correct horse battery staple");

		const before = Date.now();
		await auth.api.signInEmail({
			body: { email: "lifetime@example.test", password: "correct horse battery staple" },
			headers: new Headers(),
		});

		const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
		const lifetimeMs = session.expiresAt.getTime() - before;
		// A window rather than an equality: the row is written some milliseconds after `before`.
		expect(lifetimeMs).toBeGreaterThan(3 * 60 * 60 * 1000 - 5000);
		expect(lifetimeMs).toBeLessThan(3 * 60 * 60 * 1000 + 5000);
	});

	it("stamps lastSeenAt when the session is created", async () => {
		const user = await createCredentialUser("stamped@example.test", "correct horse battery staple");
		await auth.api.signInEmail({
			body: { email: "stamped@example.test", password: "correct horse battery staple" },
			headers: new Headers(),
		});
		const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
		expect(session.lastSeenAt).not.toBeNull();
	});
});
