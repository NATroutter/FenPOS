import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "@/lib/auth/password";
import { assertNotReused, hashAndRecord, passwordExpired, recordPasswordChange } from "@/lib/auth/password-history";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Previous passwords, and how long the current one lasts.
 *
 * Both are off by default, so most cases here set their setting first. The two that do not are the
 * important ones: the defaults are what most installs get, and a suite that only ran with the feature
 * on would not notice it becoming mandatory.
 */
describe("password history", () => {
	beforeEach(async () => {
		await prisma.passwordHistory.deleteMany({});
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
	});

	/** A fresh account. Ids are per-case so nothing shares state. */
	async function account(id: string): Promise<string> {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com` } });
		return id;
	}

	it("remembers nothing while the setting is zero", async () => {
		const id = await account("ph1");
		await recordPasswordChange(id, await hashPassword("first-password-here"));

		await expect(assertNotReused(id, "first-password-here")).resolves.toBeUndefined();
	});

	it("refuses a password the account has used before", async () => {
		await setSetting("auth.passwordReuseCount", 3);
		const id = await account("ph2");
		await recordPasswordChange(id, await hashPassword("first-password-here"));

		await expect(assertNotReused(id, "first-password-here")).rejects.toThrow(ApiError);
	});

	it("allows one it has not used", async () => {
		await setSetting("auth.passwordReuseCount", 3);
		const id = await account("ph3");
		await recordPasswordChange(id, await hashPassword("first-password-here"));

		await expect(assertNotReused(id, "second-password-here")).resolves.toBeUndefined();
	});

	it("only looks back as far as the setting says", async () => {
		await setSetting("auth.passwordReuseCount", 1);
		const id = await account("ph4");
		await recordPasswordChange(id, await hashPassword("oldest-password-here"), new Date(Date.now() - 60_000));
		await recordPasswordChange(id, await hashPassword("newest-password-here"));

		// The oldest has fallen out of a one-deep window and is available again.
		await expect(assertNotReused(id, "oldest-password-here")).resolves.toBeUndefined();
		await expect(assertNotReused(id, "newest-password-here")).rejects.toThrow(ApiError);
	});

	it("writes history even while the setting is zero", async () => {
		// So that turning the setting on later has something to compare against rather than starting
		// blind. A history that only accumulated while the feature was on would be useless for exactly
		// the first N changes after somebody enabled it.
		const id = await account("ph5");
		await recordPasswordChange(id, await hashPassword("first-password-here"));

		expect(await prisma.passwordHistory.count({ where: { userId: id } })).toBe(1);
	});

	it("stamps the account's change date", async () => {
		const id = await account("ph6");
		await recordPasswordChange(id, await hashPassword("first-password-here"));

		const user = await prisma.user.findUniqueOrThrow({ where: { id } });
		expect(user.passwordChangedAt).not.toBeNull();
	});

	it("hashes and records in one step", async () => {
		await setSetting("auth.passwordReuseCount", 3);
		const id = await account("ph7");

		const stored = await hashAndRecord(id, "first-password-here");

		expect(stored.startsWith("$argon2id$")).toBe(true);
		// The point of the helper: the hash that was stored and the hash that was remembered are the
		// same password, so the reuse check catches it.
		await expect(assertNotReused(id, "first-password-here")).rejects.toThrow(ApiError);
	});

	it("keeps one account's history away from another's", async () => {
		await setSetting("auth.passwordReuseCount", 3);
		const mine = await account("ph8");
		const theirs = await account("ph9");
		await recordPasswordChange(theirs, await hashPassword("their-password-here"));

		await expect(assertNotReused(mine, "their-password-here")).resolves.toBeUndefined();
	});

	it("goes with the account when it is deleted", async () => {
		const id = await account("ph10");
		await recordPasswordChange(id, await hashPassword("first-password-here"));

		await prisma.user.delete({ where: { id } });

		// Cascades, unlike the audit trail: a deleted account's old hashes protect nobody and are only
		// a liability to keep.
		expect(await prisma.passwordHistory.count({ where: { userId: id } })).toBe(0);
	});
});

describe("passwordExpired", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany({});
	});

	it("never expires while the setting is zero", async () => {
		const longAgo = new Date(Date.now() - 5_000 * 24 * 60 * 60 * 1000);

		expect(await passwordExpired({ passwordChangedAt: longAgo })).toBe(false);
	});

	it("expires one older than the window", async () => {
		await setSetting("auth.passwordExpiryDays", 30);
		const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

		expect(await passwordExpired({ passwordChangedAt: longAgo })).toBe(true);
	});

	it("does not expire one inside the window", async () => {
		await setSetting("auth.passwordExpiryDays", 30);
		const recently = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

		expect(await passwordExpired({ passwordChangedAt: recently })).toBe(false);
	});

	it("treats an unknown change date as not expired", async () => {
		await setSetting("auth.passwordExpiryDays", 30);

		// Every account that predates the column has one. Reading null as expired would force a
		// password change across the whole install the moment somebody turned the setting on.
		expect(await passwordExpired({ passwordChangedAt: null })).toBe(false);
	});
});
