import "server-only";
import { prisma } from "@/lib/db";
import { globalSessionPolicy } from "@/lib/settings/settings-service";

/**
 * How long a session may sit still.
 *
 * This is FenPOS's own rule rather than Better Auth's. The library has no inactivity concept at
 * all — its `updateAge` controls how often an expiry is *extended*, not when a quiet session dies.
 * Keeping the reasoning here means it lives in one place, and enforcing it here means it is
 * somewhere a test can call.
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
