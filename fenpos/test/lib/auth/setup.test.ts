import { beforeEach, describe, expect, it } from "vitest";
import { auth } from "@/lib/auth/auth";
import { completeSetup, SetupRefusedError } from "@/lib/auth/setup";
import { rotateSetupKey } from "@/lib/auth/setup-key";
import { prisma } from "@/lib/db";

/**
 * The seal.
 *
 * Setup is permitted if and only if, inside one transaction, the setup key row exists, the
 * presented key verifies, and no user exists. These tests are the specification of that
 * sentence, including the case the sentence exists for: that having got in once, nobody can get
 * in again by any route the application offers.
 */
describe("completeSetup", () => {
	const details = {
		name: "Owner",
		email: "owner@example.com",
		password: "a-sufficiently-long-password",
	};

	beforeEach(async () => {
		await prisma.setupKey.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	it("creates the first superuser with a valid key", async () => {
		const key = (await rotateSetupKey()) as string;

		const { userId } = await completeSetup({ ...details, setupKey: key });

		const user = await prisma.user.findUnique({ where: { id: userId } });
		expect(user?.email).toBe("owner@example.com");
		expect(user?.isSuperuser).toBe(true);
		expect(user?.mustChangePassword).toBe(false);
	});

	it("consumes the key, so the same key cannot be used twice", async () => {
		const key = (await rotateSetupKey()) as string;
		await completeSetup({ ...details, setupKey: key });

		expect(await prisma.setupKey.count()).toBe(0);

		await expect(completeSetup({ ...details, email: "second@example.com", setupKey: key })).rejects.toBeInstanceOf(
			SetupRefusedError,
		);

		expect(await prisma.user.count()).toBe(1);
	});

	it("refuses a wrong key", async () => {
		await rotateSetupKey();

		await expect(completeSetup({ ...details, setupKey: "XXXX-XXXX-XXXX-XXXX-XXXX" })).rejects.toBeInstanceOf(
			SetupRefusedError,
		);

		expect(await prisma.user.count()).toBe(0);
	});

	it("refuses when no key has been minted", async () => {
		await expect(completeSetup({ ...details, setupKey: "XXXX-XXXX-XXXX-XXXX-XXXX" })).rejects.toBeInstanceOf(
			SetupRefusedError,
		);
	});

	it("refuses when a user already exists, even with a valid key", async () => {
		// The case the seal exists for: a setup key row that somehow survives alongside a user
		// must still not open setup. Constructed directly, because no application path can
		// produce it.
		await prisma.user.create({
			data: { id: "existing", name: "Existing", email: "existing@example.com", updatedAt: new Date() },
		});
		const key = (await rotateSetupKeyDirectly()) as string;

		await expect(completeSetup({ ...details, setupKey: key })).rejects.toBeInstanceOf(SetupRefusedError);

		expect(await prisma.user.count()).toBe(1);
	});

	/**
	 * The adapter (`@prisma/adapter-better-sqlite3`) opens every transaction with a plain `BEGIN`
	 * (verified at `node_modules/.pnpm/@prisma+adapter-better-sqlite3@7.9.1/.../dist/index.js`,
	 * `startTransaction`), not `BEGIN IMMEDIATE`. A deferred `BEGIN` does not take SQLite's write
	 * lock until the first write, so two concurrent transactions can both read `user.count() === 0`
	 * before either has written anything — the exact race this test exists to close, made real by
	 * the adapter rather than closed by it. Distinguishing the two submissions by email would let
	 * that interleaving produce two committed users, which is not a failure of the seal but a gap
	 * this test must not paper over. So the two submissions share one email instead: `@@unique` on
	 * `User.email` guarantees the second insert fails at the database regardless of how the two
	 * transactions interleave, and "exactly one winner" is asserted the same way either mechanism
	 * would produce it.
	 */
	it("lets exactly one of two concurrent submissions win", async () => {
		const key = (await rotateSetupKey()) as string;

		const results = await Promise.allSettled([
			completeSetup({ ...details, setupKey: key }),
			completeSetup({ ...details, setupKey: key }),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(await prisma.user.count()).toBe(1);
	});

	it("refuses a password below the built-in floor", async () => {
		const key = (await rotateSetupKey()) as string;

		await expect(completeSetup({ ...details, password: "short", setupKey: key })).rejects.toThrow();
		expect(await prisma.user.count()).toBe(0);
	});

	/**
	 * Pins `completeSetup`'s hardcoded-by-import `issuer` against the library's own value.
	 *
	 * `completeSetup` writes the account row directly rather than through Better Auth, because the
	 * user and the key deletion must commit together (see setup.ts). That means the `issuer`
	 * column, which `Account` requires and which Better Auth keys credential lookups on, is set by
	 * this module rather than by the library — so this test creates a *second* user the way
	 * `account-schema.test.ts` does, through `auth.api.createUser`, and asserts that Better Auth's
	 * own write lands on the exact same `issuer` value `completeSetup` used. If a future Better
	 * Auth upgrade changes what `createLocalAccountIssuer("credential")` produces, this is what
	 * fails — not a silent mismatch discovered at sign-in.
	 */
	it("writes the same issuer Better Auth itself writes for a credential account", async () => {
		const key = (await rotateSetupKey()) as string;
		const { userId } = await completeSetup({ ...details, setupKey: key });
		const sealedAccount = await prisma.account.findFirstOrThrow({ where: { userId } });

		// No `headers`/`request` on the call: `auth.api.createUser`'s admin-permission check only
		// runs when a session or a request is present, so this bare server-side call is treated as
		// trusted and skips it — see `account-schema.test.ts` for the same reasoning.
		const created = await auth.api.createUser({
			body: { email: "library-issuer@example.com", password: details.password, name: "Library Issuer" },
		});
		const libraryAccount = await prisma.account.findFirstOrThrow({ where: { userId: created.user.id } });

		expect(sealedAccount.issuer).toBe(libraryAccount.issuer);
	});
});

/**
 * Writes a setup key row without `rotateSetupKey`'s claimed-install guard.
 *
 * Needed by the "user already exists" case above, which has to construct a state the application
 * refuses to produce: a live setup key alongside a user. Going through `rotateSetupKey` there
 * would test that guard a second time rather than testing the seal.
 *
 * @returns the plaintext key
 */
async function rotateSetupKeyDirectly(): Promise<string> {
	const { generatePassword, hashSecret } = await import("@/lib/auth/secrets");
	const plaintext = generatePassword();
	await prisma.setupKey.upsert({
		where: { id: 1 },
		update: { keyHash: hashSecret(plaintext) },
		create: { id: 1, keyHash: hashSecret(plaintext) },
	});
	return plaintext;
}
