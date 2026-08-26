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
		// Named rather than left to the fallback: the cap is the *other* reader of `lastSeenAt`, and
		// these tests are about what happens with only the timeout in play.
		await setSetting("auth.maxConcurrentSessions", 0);
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

	/**
	 * Both intervals set to the same number of minutes, which the settings page allows and an operator
	 * reading "refresh the last-seen time every ten minutes, end a session after ten idle minutes"
	 * would think reasonable. Unclamped, the refresh only fires in the millisecond before the timeout
	 * does, so a panel in constant use is signed out on the interval anyway.
	 */
	it("refreshes well before the timeout when both intervals are set the same", async () => {
		await setSetting("auth.idleTimeoutMinutes", 10);
		await setSetting("auth.lastSeenRefreshMinutes", 10);
		await sessionLastSeen("tie", 6);

		expect(await keepSessionAlive("tie")).toBe(true);

		const row = await prisma.session.findUniqueOrThrow({ where: { id: "tie" } });
		expect(Date.now() - (row.lastSeenAt?.getTime() ?? 0)).toBeLessThan(5000);
	});

	/**
	 * The mode `/api/events` gates with. A request the browser made on its own is not evidence anybody
	 * used the session, so it is measured against the stamp without moving it — otherwise a stream that
	 * reconnects more often than the timeout would keep an unattended terminal signed in for good.
	 */
	it("leaves last-seen alone for a request that does not count as activity", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		const at = await sessionLastSeen("uncounted", 20);

		expect(await keepSessionAlive("uncounted", { countsAsActivity: false })).toBe(true);

		const row = await prisma.session.findUniqueOrThrow({ where: { id: "uncounted" } });
		expect(row.lastSeenAt?.getTime()).toBe(at.getTime());
	});

	it("still ends an idle session for a request that does not count as activity", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		await sessionLastSeen("uncounted-stale", 31);
		expect(await keepSessionAlive("uncounted-stale", { countsAsActivity: false })).toBe(false);
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

	it("evicts by last-seen time, not by creation order", async () => {
		// The `sessions()` fixture above stamps createdAt, updatedAt and lastSeenAt identically, so it
		// cannot tell a last-seen ordering from a creation-time one. This test makes the two disagree:
		// the session created earliest is the one still in use, and the session created most recently
		// is the one nobody has touched in over an hour.
		await setSetting("auth.maxConcurrentSessions", 2);
		await prisma.user.create({
			data: { id: "cap-diverge", name: "cap-diverge", email: "cap-diverge@example.test", emailVerified: false },
		});
		const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60 * 1000);
		const row = (id: string, createdMinutesAgo: number, seenMinutesAgo: number) => ({
			id,
			token: `t-${id}`,
			userId: "cap-diverge",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			createdAt: minutesAgo(createdMinutesAgo),
			updatedAt: minutesAgo(seenMinutesAgo),
			lastSeenAt: minutesAgo(seenMinutesAgo),
		});
		// Created first (180 minutes ago) but seen a minute ago: must survive.
		await prisma.session.create({ data: row("cap-diverge-a", 180, 1) });
		// Created after A but idle for 90 minutes: outlasts C, loses to A.
		await prisma.session.create({ data: row("cap-diverge-b", 120, 90) });
		// Created most recently of the three (60 minutes ago) but idle the longest, at 100 minutes:
		// last out, first evicted. Ordering by createdAt instead of lastSeenAt would evict A instead.
		await prisma.session.create({ data: row("cap-diverge-c", 60, 100) });

		expect(await enforceSessionCap("cap-diverge", null)).toBe(1);
		const left = await prisma.session.findMany({ where: { userId: "cap-diverge" }, select: { id: true } });
		expect(left.map((entry) => entry.id).sort()).toEqual(["cap-diverge-a", "cap-diverge-b"].sort());
	});

	it("never evicts the session that was just created, however old its stamp looks", async () => {
		await setSetting("auth.maxConcurrentSessions", 1);
		const ids = await sessions("cap-keep", 3);
		// ids[0] is the *oldest* — pass it as the one to keep and it must survive anyway.
		await enforceSessionCap("cap-keep", ids[0]);
		const left = await prisma.session.findMany({ where: { userId: "cap-keep" }, select: { id: true } });
		expect(left.map((row) => row.id)).toEqual([ids[0]]);
	});

	/**
	 * The default install: a cap set, no inactivity timeout.
	 *
	 * The ordering test above builds its `lastSeenAt` values by hand, so it proves only that
	 * `enforceSessionCap` sorts on the column — never that anything keeps the column current. This one
	 * goes through the real refresh path instead, which is where the two settings meet: with the
	 * timeout off, `keepSessionAlive` used to return before reading or writing anything, every stamp
	 * stayed frozen at creation, and "least recently used" degenerated into "oldest". The session an
	 * operator was actively using was then the first one evicted.
	 */
	it("evicts by use, not by age, when there is no inactivity timeout", async () => {
		await setSetting("auth.idleTimeoutMinutes", 0);
		await setSetting("auth.maxConcurrentSessions", 1);
		await prisma.user.create({
			data: { id: "cap-lru", name: "cap-lru", email: "cap-lru@example.test", emailVerified: false },
		});
		const quiet = (id: string, minutesAgo: number) => {
			const at = new Date(Date.now() - minutesAgo * 60 * 1000);
			return prisma.session.create({
				data: {
					id,
					token: `t-${id}`,
					userId: "cap-lru",
					expiresAt: new Date(Date.now() + 60 * 60 * 1000),
					createdAt: at,
					updatedAt: at,
					lastSeenAt: at,
				},
			});
		};
		// Opened first, and the one still in front of somebody.
		await quiet("cap-lru-older", 180);
		// Opened later, then abandoned.
		await quiet("cap-lru-newer", 90);

		// The request that arrives on the older session is what makes it the recently used one.
		expect(await keepSessionAlive("cap-lru-older")).toBe(true);

		expect(await enforceSessionCap("cap-lru", null)).toBe(1);
		const left = await prisma.session.findMany({ where: { userId: "cap-lru" }, select: { id: true } });
		expect(left.map((row) => row.id)).toEqual(["cap-lru-older"]);
	});

	it("touches nobody else's sessions", async () => {
		await setSetting("auth.maxConcurrentSessions", 1);
		const mine = await sessions("cap-mine", 3);
		await sessions("cap-theirs", 3);
		await enforceSessionCap("cap-mine", mine[2]);
		expect(await prisma.session.count({ where: { userId: "cap-theirs" } })).toBe(3);
	});
});
