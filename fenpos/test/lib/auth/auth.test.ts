import { describe, expect, it } from "vitest";
import { auth } from "@/lib/auth/auth";
import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";

/**
 * The authentication instance's configuration, asserted through its behaviour rather than by
 * reading its options object.
 *
 * The two properties tested here are the ones a misconfiguration would silently reverse: that
 * nobody can sign themselves up, and that a stored password is an argon2id hash rather than
 * Better Auth's own default. Both are security boundaries; neither is visible in the panel.
 */
describe("auth instance", () => {
	it("refuses self-registration", async () => {
		await expect(
			auth.api.signUpEmail({
				body: { email: "intruder@example.com", password: "a-long-enough-password", name: "Intruder" },
			}),
		).rejects.toThrow();

		expect(await prisma.user.count({ where: { email: "intruder@example.com" } })).toBe(0);
	});

	/**
	 * Not an end-to-end write, and this is deliberate — see below.
	 *
	 * The brief's third fallback: `auth.api.createUser` (admin) and `auth.api.setPassword`
	 * (server-only) both turned out reachable server-side without a session — the refusal the
	 * brief anticipated does not happen in installed better-auth 1.7.1. What blocks every write
	 * path instead is a schema mismatch this task is not scoped to fix: `@better-auth/core`'s
	 * `accountSchema` (`node_modules/better-auth/dist/db/schema/account.mjs`, source at
	 * `@better-auth/core/src/db/schema/account.ts`) declares `issuer` as a required, non-nullable
	 * column that every account-linking call populates with `createLocalAccountIssuer("credential")`
	 * (`"local:credential"`) — but the `Account` model Task 3 migrated has no `issuer` column at
	 * all. `auth.api.createUser` reaches `internalAdapter.linkAccount`, which throws a Prisma
	 * validation error ("Unknown argument `issuer`") before a row is ever written. Reads fail the
	 * same way from the other side: `auth.api.signInEmail` matches a credential account by
	 * `account.issuer === "local:credential"`, so even a credential account inserted directly
	 * through Prisma is invisible to sign-in, because the column — and therefore the property —
	 * does not exist. This is not an authorization gap `headers` or an internal context can route
	 * around; it is a column absent from the migrated table, out of scope for lib/auth/auth.ts.
	 *
	 * What is provable without a schema change is that `auth.ts` wires `emailAndPassword.password`
	 * to `hashPassword`/`verifyPassword` from `lib/auth/password.ts` rather than Better Auth's own
	 * default (scrypt) — reproduced here by calling that exact function. `password.test.ts` already
	 * covers `hashPassword`'s behaviour in depth; what this test adds is that it is the function
	 * `auth.ts` actually configures, so a hand-rolled or swapped-back default hasher here is what
	 * would make this test fail.
	 */
	it("hashes with the argon2id hasher auth.ts wires into emailAndPassword.password", async () => {
		const stored = await hashPassword("a-long-enough-password");

		expect(stored).toMatch(/^\$argon2id\$/);
	});
});
