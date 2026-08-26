import { beforeEach, describe, expect, it } from "vitest";
import { enforceSessionCap, keepSessionAlive } from "@/lib/auth/session-policy";
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

describe("enforceSessionCap", () => {
	/** `count` sessions for one user, oldest-seen first. */
	async function sessions(userId: string, count: number): Promise<string[]> {
		await prisma.user.create({
			data: { id: userId, name: userId, email: `${userId}@example.test`, emailVerified: false },
		});
		const ids: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const at = new Date(Date.now() - (count - index) * 60 * 1000);
			const id = `${userId}-${index}`;
			await prisma.session.create({
				data: {
					id,
					token: `t-${id}`,
					userId,
					expiresAt: new Date(Date.now() + 60 * 60 * 1000),
					createdAt: at,
					updatedAt: at,
					lastSeenAt: at,
				},
			});
			ids.push(id);
		}
		return ids;
	}

	beforeEach(async () => {
		await prisma.session.deleteMany({});
		await prisma.user.deleteMany({});
		await setSetting("auth.maxConcurrentSessions", 0);
	});

	it("deletes nothing when the cap is unlimited", async () => {
		const ids = await sessions("cap-off", 6);
		expect(await enforceSessionCap("cap-off", ids[5])).toBe(0);
		expect(await prisma.session.count({ where: { userId: "cap-off" } })).toBe(6);
	});

	it("deletes nothing while the account is under the cap", async () => {
		await setSetting("auth.maxConcurrentSessions", 3);
		const ids = await sessions("cap-under", 3);
		expect(await enforceSessionCap("cap-under", ids[2])).toBe(0);
	});

	it("evicts the least recently seen sessions once the cap is exceeded", async () => {
		await setSetting("auth.maxConcurrentSessions", 2);
		const ids = await sessions("cap-over", 5);
		expect(await enforceSessionCap("cap-over", ids[4])).toBe(3);
		const left = await prisma.session.findMany({ where: { userId: "cap-over" }, select: { id: true } });
		expect(left.map((row) => row.id).sort()).toEqual([ids[3], ids[4]].sort());
	});

	it("never evicts the session that was just created, however old its stamp looks", async () => {
		await setSetting("auth.maxConcurrentSessions", 1);
		const ids = await sessions("cap-keep", 3);
		// ids[0] is the *oldest* — pass it as the one to keep and it must survive anyway.
		await enforceSessionCap("cap-keep", ids[0]);
		const left = await prisma.session.findMany({ where: { userId: "cap-keep" }, select: { id: true } });
		expect(left.map((row) => row.id)).toEqual([ids[0]]);
	});

	it("touches nobody else's sessions", async () => {
		await setSetting("auth.maxConcurrentSessions", 1);
		const mine = await sessions("cap-mine", 3);
		await sessions("cap-theirs", 3);
		await enforceSessionCap("cap-mine", mine[2]);
		expect(await prisma.session.count({ where: { userId: "cap-theirs" } })).toBe(3);
	});
});
