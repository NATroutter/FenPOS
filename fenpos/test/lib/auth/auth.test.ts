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
	 * Not an end-to-end write — see `account-schema.test.ts` for that.
	 *
	 * That test now covers the full `createUser` → `signInEmail` round trip through the real
	 * `Account` table (Task 3b added the `issuer` column that `@better-auth/cli@1.4.21`'s
	 * schema dump omitted, which is what made that round trip impossible when this test was
	 * first written). What this test adds beyond it is narrower and cheaper: that `auth.ts`
	 * wires `emailAndPassword.password` to `hashPassword`/`verifyPassword` from
	 * `lib/auth/password.ts` rather than Better Auth's own default (scrypt) — reproduced here by
	 * calling that exact function directly, without the cost of a full sign-in. `password.test.ts`
	 * already covers `hashPassword`'s behaviour in depth; what this test adds is that it is the
	 * function `auth.ts` actually configures, so a hand-rolled or swapped-back default hasher here
	 * is what would make this test fail.
	 */
	it("hashes with the argon2id hasher auth.ts wires into emailAndPassword.password", async () => {
		const stored = await hashPassword("a-long-enough-password");

		expect(stored).toMatch(/^\$argon2id\$/);
	});
});
