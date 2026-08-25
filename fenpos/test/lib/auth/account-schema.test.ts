import { describe, expect, it } from "vitest";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db";

/**
 * Proves the library and the `Account` table actually agree, end to end.
 *
 * Task 3 migrated the five Better Auth models from a `@better-auth/cli@1.4.21` schema dump — a
 * minor version behind the installed `better-auth`/`@better-auth/core` 1.7.1 — and the CLI's
 * `account` table had no `issuer` column. Every write and read of a credential account keys off
 * `issuer` (`@better-auth/core/dist/db/get-tables.mjs`, `internalAdapter.linkAccount` and
 * `findAccountByKey`, and `sign-in/email`'s own lookup), so the missing column did not surface as
 * a type error anywhere — Prisma's generated client just doesn't know the field exists — it
 * surfaced only at runtime, as a validation error from `linkAccount` and a silent "no such
 * account" from sign-in. A unit test that stubs Prisma cannot catch that class of bug, because the
 * bug is that the schema and the library disagree about what the database looks like; only a real
 * migrated database driven through the real `auth` instance can.
 *
 * This is deliberately not a hasher-only test. `auth.test.ts` already covers that `auth.ts` wires
 * `hashPassword`/`verifyPassword` into `emailAndPassword.password`; what this test adds is that a
 * user created through Better Auth's own write path can sign in through Better Auth's own read
 * path, and that what lands in `account.password` is the argon2id hash `hashPassword` produces —
 * not Better Auth's default scrypt hash, which is what would land there if `auth.ts`'s override
 * were silently bypassed.
 */
describe("account schema", () => {
	it("creates a user with a password, signs that user in, and stores an argon2id hash", async () => {
		const email = "schema-check@example.com";
		const password = "a-long-enough-password";

		// No `headers`/`request` on the call: `auth.api.createUser`'s admin-permission check only
		// runs when a session or a request is present (`plugins/admin/routes.mjs`), so a bare
		// server-side call like this one is treated as trusted and skips it — the same path
		// first-run setup and the account-management service use to create the very first user,
		// before any session exists to authorize the call.
		const created = await auth.api.createUser({
			body: { email, password, name: "Schema Check" },
		});

		expect(created.user.email).toBe(email);

		const signedIn = await auth.api.signInEmail({
			body: { email, password },
		});

		expect(signedIn.user.email).toBe(email);
		expect(signedIn.token).toEqual(expect.any(String));

		const account = await prisma.account.findFirst({ where: { userId: created.user.id } });

		expect(account?.password).toMatch(/^\$argon2id\$/);
	});
});
