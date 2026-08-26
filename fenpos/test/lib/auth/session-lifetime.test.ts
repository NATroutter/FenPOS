import { beforeEach, describe, expect, it } from "vitest";
import { createAccount, type NewAccountInput } from "@/lib/auth/account-service";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Session lifetime comes from a setting, not from the module-load constant it used to be.
 *
 * The row is what the session gate reads on every subsequent request, so the row is where the
 * setting has to land — but a token that claimed one lifetime over a row that held another would
 * expire at whichever came first, silently, so the cookie is asserted here too. Better Auth derives
 * the session cookie's `Max-Age` from `session.expiresIn`, a module-load value the setting cannot
 * reach; the tests below pin both halves of the arrangement that keeps the row the authority — a
 * cookie that outlasts any lifetime the setting can name, and a library refresh that no longer
 * rewrites the row's expiry out from under the creation hook.
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

	/**
	 * The `Set-Cookie` itself, not the row.
	 *
	 * This is the assertion this file's own header argues for and did not previously make. With
	 * `session.expiresIn` left at an hour, every one of these sessions was handed a cookie the browser
	 * would drop sixty minutes in, whatever `auth.sessionHours` said — the row would still read twelve
	 * hours and the panel would still render a twelve-hour countdown.
	 */
	it("issues a session cookie that outlasts the row rather than cutting it short", async () => {
		await setSetting("auth.sessionHours", 12);
		await createCredentialUser("cookie@example.test", "correct horse battery staple");

		const response = await auth.api.signInEmail({
			body: { email: "cookie@example.test", password: "correct horse battery staple" },
			headers: new Headers(),
			asResponse: true,
		});

		const setCookie = response.headers.getSetCookie().find((entry) => entry.startsWith("better-auth.session_token="));
		const maxAge = Number(/max-age=(\d+)/i.exec(setCookie ?? "")?.[1]);
		expect(Number.isFinite(maxAge)).toBe(true);
		expect(maxAge).toBeGreaterThanOrEqual(12 * 60 * 60);
	});

	/**
	 * The other half. Better Auth's own refresh overwrites `expiresAt` with the module-load ceiling,
	 * which would hand every session thirty days and make the setting decorative — so refresh is off,
	 * and reading the session must leave the row exactly where the creation hook put it.
	 */
	it("does not extend the row when the session is read", async () => {
		await setSetting("auth.sessionHours", 3);
		const user = await createCredentialUser("norefresh@example.test", "correct horse battery staple");

		const response = await auth.api.signInEmail({
			body: { email: "norefresh@example.test", password: "correct horse battery staple" },
			headers: new Headers(),
			asResponse: true,
		});
		const jar = response.headers
			.getSetCookie()
			.map((entry) => entry.split(";")[0])
			.join("; ");

		const before = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
		await auth.api.getSession({ headers: new Headers({ cookie: jar }) });
		const after = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });

		expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
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
