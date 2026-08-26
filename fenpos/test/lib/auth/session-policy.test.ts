import { beforeEach, describe, expect, it } from "vitest";
import { keepSessionAlive } from "@/lib/auth/session-policy";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Inactivity is FenPOS's own concept — Better Auth has none — so these are the rules in full.
 */
describe("keepSessionAlive", () => {
	beforeEach(async () => {
		await prisma.session.deleteMany({});
		await prisma.user.deleteMany({});
		await setSetting("auth.idleTimeoutMinutes", 0);
		await setSetting("auth.lastSeenRefreshMinutes", 5);
	});

	/** A session row `minutesAgo` since it was last seen. Returns that timestamp for callers that need it. */
	async function sessionLastSeen(id: string, minutesAgo: number): Promise<Date> {
		const user = await prisma.user.create({
			data: { id: `u-${id}`, name: id, email: `${id}@example.test`, emailVerified: false },
		});
		const at = new Date(Date.now() - minutesAgo * 60 * 1000);
		await prisma.session.create({
			data: {
				id,
				token: `t-${id}`,
				userId: user.id,
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				createdAt: at,
				updatedAt: at,
				lastSeenAt: at,
			},
		});
		return at;
	}

	it("keeps a session alive when the timeout is off, however quiet it has been", async () => {
		await sessionLastSeen("quiet", 60 * 24 * 7);
		expect(await keepSessionAlive("quiet")).toBe(true);
	});

	it("ends a session that has been idle longer than the timeout", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		await sessionLastSeen("stale", 31);
		expect(await keepSessionAlive("stale")).toBe(false);
	});

	it("keeps a session that has been idle for less than the timeout", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		await sessionLastSeen("fresh", 29);
		expect(await keepSessionAlive("fresh")).toBe(true);
	});

	it("rewrites last-seen once it is staler than the refresh interval", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		await sessionLastSeen("refreshed", 10);
		await keepSessionAlive("refreshed");
		const row = await prisma.session.findUniqueOrThrow({ where: { id: "refreshed" } });
		expect(Date.now() - (row.lastSeenAt?.getTime() ?? 0)).toBeLessThan(5000);
	});

	it("leaves last-seen alone while it is fresher than the refresh interval", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		await sessionLastSeen("recent", 1);
		const before = await prisma.session.findUniqueOrThrow({ where: { id: "recent" } });
		await keepSessionAlive("recent");
		const after = await prisma.session.findUniqueOrThrow({ where: { id: "recent" } });
		expect(after.lastSeenAt?.getTime()).toBe(before.lastSeenAt?.getTime());
	});

	it("falls back to updatedAt for a row written before the column existed", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		const at = await sessionLastSeen("legacy", 31);
		// `updatedAt` is `@updatedAt` in the schema, so it must be restated here — an update that left it
		// implicit would have Prisma stamp it with the current time and defeat the point of this row.
		await prisma.session.update({ where: { id: "legacy" }, data: { lastSeenAt: null, updatedAt: at } });
		expect(await keepSessionAlive("legacy")).toBe(false);
	});

	it("says no to a session that is not there", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		expect(await keepSessionAlive("missing")).toBe(false);
	});
});
