import { beforeEach, describe, expect, it } from "vitest";
import { assertNotLastSuperuser, assertNotSelf } from "@/lib/auth/account-guards";
import { prisma } from "@/lib/db";

/**
 * The two ways an install can be locked out of itself.
 *
 * Deleting or banning the only superuser leaves nobody who can undo it, and there is no email loop
 * and no re-openable setup to recover through — the only route back would be the phase 8 recovery
 * CLI, which needs filesystem access. Banning yourself is the same failure with one extra step.
 * Both are checked here rather than in the dialog, because a dialog is not a boundary.
 */
describe("account guards", () => {
	beforeEach(async () => {
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	async function account(id: string, isSuperuser: boolean) {
		return prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser } });
	}

	describe("assertNotSelf", () => {
		it("refuses, naming the verb, when the target is the actor", () => {
			expect(() => assertNotSelf("a1", "a1", "ban")).toThrow(/ban your own account/i);
		});

		it("allows any other target", () => {
			expect(() => assertNotSelf("a1", "a2", "ban")).not.toThrow();
		});
	});

	describe("assertNotLastSuperuser", () => {
		it("refuses when the target is the only superuser left", async () => {
			await account("s1", true);
			await account("u1", false);

			await expect(assertNotLastSuperuser("s1", "deleted")).rejects.toThrow(/last superuser/i);
		});

		it("allows it once a second superuser exists", async () => {
			await account("s2", true);
			await account("s3", true);

			await expect(assertNotLastSuperuser("s2", "deleted")).resolves.toBeUndefined();
		});

		it("allows any account that is not a superuser", async () => {
			await account("s4", true);
			await account("u2", false);

			await expect(assertNotLastSuperuser("u2", "deleted")).resolves.toBeUndefined();
		});

		it("refuses an account that does not exist", async () => {
			await expect(assertNotLastSuperuser("nobody", "deleted")).rejects.toThrow(/no longer exists/i);
		});
	});
});
