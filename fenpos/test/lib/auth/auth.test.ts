import { describe, expect, it } from "vitest";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db";

/**
 * The authentication instance's configuration, asserted through its behaviour rather than by
 * reading its options object.
 *
 * Only one property is asserted here: that nobody can sign themselves up. That is a security
 * boundary invisible in the panel, so it earns its own behavioural test. Whether `auth.ts` wires
 * the argon2id hasher into `emailAndPassword.password` — the other property this file used to
 * assert, by calling `hashPassword` directly — is no longer tested here: calling `hashPassword`
 * in isolation never touched `auth.ts`'s configuration, so it proved nothing about the wiring and
 * would still have passed even if `auth.ts`'s `password: { hash, verify }` block were deleted.
 * `account-schema.test.ts` proves that wiring for real, by creating a user through
 * `auth.api.createUser` and checking the hash Better Auth itself stored. `password.test.ts`
 * separately covers `hashPassword`'s own behaviour. Between those two, nothing here was worth
 * keeping.
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
});
