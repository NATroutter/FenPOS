import { beforeEach, describe, expect, it } from "vitest";
import { clearFailedSignIns, lockedOutFor, recordFailedSignIn } from "@/lib/auth/lockout";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Per-account lockout.
 *
 * A second mechanism beside `auth.signInAttemptsPerMinute`, which keys on the client address. That
 * one defends the server against grinding and resets on success; this one defends a single password
 * against an attacker who has more than one address to come from.
 *
 * Keyed by email rather than by user id, because the sign-in path has an address and not yet an
 * account — and an email matching nothing must behave exactly like one that does, or the endpoint
 * becomes a way to ask which addresses hold accounts.
 */
describe("lockout", () => {
	beforeEach(async () => {
		await prisma.user.deleteMany({});
		await prisma.setting.deleteMany({});
		await setSetting("auth.lockoutAfterFailures", 3);
		await setSetting("auth.lockoutMinutes", 15);
	});

	/** A fresh account, returning the address to sign in with. */
	async function account(id: string): Promise<string> {
		await prisma.user.create({ data: { id, name: id, email: `${id}@example.com` } });
		return `${id}@example.com`;
	}

	it("does not lock while the setting is zero", async () => {
		await setSetting("auth.lockoutAfterFailures", 0);
		const email = await account("lo1");

		for (let attempt = 0; attempt < 10; attempt++) {
			await recordFailedSignIn(email);
		}

		expect(await lockedOutFor(email)).toBe(0);
	});

	it("locks after the configured number of failures, and not before", async () => {
		const email = await account("lo2");

		await recordFailedSignIn(email);
		await recordFailedSignIn(email);
		expect(await lockedOutFor(email)).toBe(0);

		await recordFailedSignIn(email);
		expect(await lockedOutFor(email)).toBeGreaterThan(0);
	});

	it("clears itself once the duration passes", async () => {
		const email = await account("lo3");
		for (let attempt = 0; attempt < 3; attempt++) {
			await recordFailedSignIn(email);
		}

		const later = new Date(Date.now() + 16 * 60 * 1000);
		expect(await lockedOutFor(email, later)).toBe(0);
	});

	it("forgets the failures once a sign-in succeeds", async () => {
		const email = await account("lo4");
		await recordFailedSignIn(email);
		await recordFailedSignIn(email);

		await clearFailedSignIns("lo4");

		// Back to a clean slate: one more failure is the first, not the third.
		await recordFailedSignIn(email);
		expect(await lockedOutFor(email)).toBe(0);
	});

	it("says nothing about an address that matches no account", async () => {
		// The endpoint must not become a way to ask which addresses hold accounts, so an unknown one
		// records nothing and reports no lock — exactly as a known one under its threshold does.
		await recordFailedSignIn("nobody@example.com");

		expect(await lockedOutFor("nobody@example.com")).toBe(0);
	});

	it("matches an address however it was capitalised or spaced", async () => {
		const email = await account("lo5");
		for (let attempt = 0; attempt < 3; attempt++) {
			await recordFailedSignIn(`  ${email.toUpperCase()}  `);
		}

		expect(await lockedOutFor(email)).toBeGreaterThan(0);
	});

	it("keeps the lock fresh while an attacker keeps guessing", async () => {
		const email = await account("lo6");
		for (let attempt = 0; attempt < 3; attempt++) {
			await recordFailedSignIn(email);
		}
		const firstLock = await lockedOutFor(email);

		const later = new Date(Date.now() + 10 * 60 * 1000);
		await recordFailedSignIn(email, later);

		// Extended from the newest failure rather than left to expire on the original schedule.
		expect(await lockedOutFor(email, later)).toBeGreaterThan(firstLock - 10 * 60 * 1000);
	});

	it("locks one account without touching another", async () => {
		const mine = await account("lo7");
		const theirs = await account("lo8");
		for (let attempt = 0; attempt < 3; attempt++) {
			await recordFailedSignIn(mine);
		}

		expect(await lockedOutFor(theirs)).toBe(0);
	});
});
