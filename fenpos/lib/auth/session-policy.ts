import "server-only";
import { prisma } from "@/lib/db";
import { globalSessionPolicy } from "@/lib/settings/settings-service";

/**
 * How long a session may sit still, and how many an account may hold.
 *
 * Both are FenPOS's rules rather than Better Auth's. The library has no inactivity concept at
 * all — its `updateAge` controls how often an expiry is *extended*, not when a quiet session
 * dies — and its session limit, where one exists, refuses the new session rather than retiring
 * an old one, which is the wrong trade on a till. Keeping both here means the reasoning is in
 * one place and the enforcement is somewhere a test can call.
 */

/**
 * Decides whether a session may continue, and marks it as seen if so.
 *
 * Called from the session gate on every request, which is why it is one read and at most one write
 * rather than a check followed by a touch. The write is skipped while the stored time is fresher
 * than `auth.lastSeenRefreshMinutes` — without that, a panel that polls would write to the session
 * row several times a second for as long as it was open.
 *
 * A missing row is **not** alive. It is the same answer a deleted session should get, and getting
 * it here rather than from a later null dereference means a session revoked from the Users page
 * stops working on the revoked user's very next request.
 *
 * A null `lastSeenAt` falls back to `updatedAt`, which Better Auth sets when it writes the row.
 * Only sessions created before the column existed can have one — every session created since is
 * stamped by the `databaseHooks.session.create.before` hook in `auth.ts`.
 *
 * @param sessionId the session this request arrived on
 * @returns true when the session may continue; false when it is gone or has been idle too long
 */
export async function keepSessionAlive(sessionId: string): Promise<boolean> {
	const { idleTimeoutMs, lastSeenRefreshMs } = await globalSessionPolicy();

	// Off is the default, and the default should cost nothing. Nothing reads `lastSeenAt` when
	// there is no timeout to measure it against, so there is nothing to read or write.
	if (idleTimeoutMs === 0) {
		return true;
	}

	const session = await prisma.session.findUnique({
		where: { id: sessionId },
		select: { lastSeenAt: true, updatedAt: true },
	});
	if (!session) {
		return false;
	}

	const lastSeen = (session.lastSeenAt ?? session.updatedAt).getTime();
	const idleFor = Date.now() - lastSeen;
	if (idleFor > idleTimeoutMs) {
		return false;
	}

	if (idleFor >= lastSeenRefreshMs) {
		await prisma.session.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } });
	}

	return true;
}

/**
 * Retires an account's oldest sessions until it holds no more than the install allows.
 *
 * **Evicts rather than refuses.** Better Auth's own session limits, where they exist, turn the new
 * sign-in away; this does the opposite, because the person being turned away is the one at the
 * keyboard and the sessions in the way are usually a crashed browser and a machine somebody walked
 * away from. Turning them away would make a stale row into an outage on a till, which is the same
 * trade `auth.lockoutAfterFailures` is deliberately off by default for.
 *
 * Ordered by last seen rather than by creation, so "the one nobody is using" is what goes — a
 * session opened this morning and used a minute ago outranks one opened an hour ago and abandoned.
 *
 * `keepSessionId` is never evicted. Without it a cap of one would race with itself: the session
 * just created has the newest stamp, but only by milliseconds, and a clock with coarse resolution
 * could sort it behind an existing one and sign the caller straight back out.
 *
 * Called from the sign-in path rather than from `databaseHooks.session.create.after`, because this
 * deletes rows and that hook may run inside Better Auth's own transaction — a delete there is how a
 * SQLite deadlock is bought. There are exactly two places a session is created in this codebase and
 * both are ours.
 *
 * @param userId the account to bring under the cap
 * @param keepSessionId a session that must survive whatever else goes, or null
 * @returns how many sessions were deleted
 */
export async function enforceSessionCap(userId: string, keepSessionId: string | null): Promise<number> {
	const { maxConcurrentSessions } = await globalSessionPolicy();

	// Unlimited is the default, and costs one settings read and nothing else.
	if (maxConcurrentSessions === 0) {
		return 0;
	}

	const held = await prisma.session.findMany({
		where: { userId },
		orderBy: [{ lastSeenAt: "desc" }, { updatedAt: "desc" }],
		select: { id: true },
	});

	// The kept session is pulled to the front rather than filtered out of the count: it occupies one
	// of the allowed places, which is what makes a cap of one mean "this session and no other".
	const ordered = [
		...held.filter((row) => row.id === keepSessionId),
		...held.filter((row) => row.id !== keepSessionId),
	];
	const doomed = ordered.slice(maxConcurrentSessions).map((row) => row.id);
	if (doomed.length === 0) {
		return 0;
	}

	const { count } = await prisma.session.deleteMany({ where: { id: { in: doomed } } });
	return count;
}
