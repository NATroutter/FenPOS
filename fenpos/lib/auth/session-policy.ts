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
 * Decides whether a session may continue, and marks it as seen unless the caller says not to.
 *
 * Called from the session gate on every request, which is why it is one read and at most one write
 * rather than a check followed by a touch. The write is skipped while the stored time is fresher
 * than `auth.lastSeenRefreshMinutes` — without that, a panel that polls would write to the session
 * row several times a second for as long as it was open.
 *
 * **`countsAsActivity` decides whether the request is evidence a person is there.** `lastSeenAt`
 * means "when this session was last *used*", and both readers of it below depend on that: the
 * timeout ends a session nobody is sitting in front of, and the cap evicts the one least recently
 * used. A request the browser makes on its own satisfies neither — `/api/events` is reopened by
 * `EventSource` after every dropped connection, with no user involved and no code of ours called —
 * so a caller like that passes false and is judged against the stamp without moving it. Refusal is
 * unaffected: an idle session is refused either way, and only the write is suppressed.
 *
 * **Two settings read `lastSeenAt`, not one.** The inactivity timeout is the obvious one; the
 * concurrency cap below is the other, and it orders by that same column. So the early return is
 * taken only when *both* are off — with the cap on and the timeout off, skipping the refresh would
 * freeze every stamp at the moment its session was created and quietly turn "least recently used"
 * into "oldest", evicting exactly the session an operator was most likely still sitting in front of.
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
 * @param options `countsAsActivity` — whether this request should refresh `lastSeenAt`. Defaults to
 *   true, which is what a request a person made means; pass false only for one the browser makes by
 *   itself.
 * @returns true when the session may continue; false when it is gone or has been idle too long
 */
export async function keepSessionAlive(
	sessionId: string,
	options: { countsAsActivity?: boolean } = {},
): Promise<boolean> {
	const { countsAsActivity = true } = options;
	const { idleTimeoutMs, lastSeenRefreshMs, maxConcurrentSessions } = await globalSessionPolicy();

	// Both off is the default, and the default should cost nothing: with no timeout to measure
	// `lastSeenAt` against and no cap to order by, nothing reads it and there is nothing to write.
	if (idleTimeoutMs === 0 && maxConcurrentSessions === 0) {
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
	// Guarded on the timeout being set, not merely on the comparison: zero means "never end a session
	// for inactivity", and an unguarded `idleFor > 0` would end every one of them instead.
	if (idleTimeoutMs > 0 && idleFor > idleTimeoutMs) {
		return false;
	}

	if (countsAsActivity && idleFor >= refreshIntervalMs(idleTimeoutMs, lastSeenRefreshMs)) {
		await prisma.session.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } });
	}

	return true;
}

/**
 * How stale `lastSeenAt` may get before it is rewritten, clamped so the refresh always beats the
 * timeout to it.
 *
 * `auth.lastSeenRefreshMinutes` is a write-rate control and the operator sets it freely, but the two
 * settings share a clock: a refresh interval equal to the timeout leaves a one-millisecond window in
 * which the stamp can be rewritten, so a panel in constant use would still be judged idle at the
 * interval and signed out. Both settings have a minimum of one minute, so equality is reachable by
 * accident, and the setting's own description could only ever warn against it. Halving the timeout
 * is the smallest interval that guarantees a live session is stamped before it is measured.
 *
 * @param idleTimeoutMs the inactivity timeout, or zero when there is none
 * @param lastSeenRefreshMs the configured refresh interval
 * @returns the interval to actually use
 */
function refreshIntervalMs(idleTimeoutMs: number, lastSeenRefreshMs: number): number {
	return idleTimeoutMs === 0 ? lastSeenRefreshMs : Math.min(lastSeenRefreshMs, Math.floor(idleTimeoutMs / 2));
}

/**
 * Retires an account's quietest sessions until it holds no more than the install allows.
 *
 * **Evicts rather than refuses.** Better Auth's own session limits, where they exist, turn the new
 * sign-in away; this does the opposite, because the person being turned away is the one at the
 * keyboard and the sessions in the way are usually a crashed browser and a machine somebody walked
 * away from. Turning them away would make a stale row into an outage on a till, which is the same
 * trade `auth.lockoutAfterFailures` is deliberately off by default for.
 *
 * Ordered by last seen rather than by creation, so "the one nobody is using" is what goes — a
 * session opened this morning and used a minute ago outranks one opened an hour ago and abandoned.
 * That ordering is only as good as the stamp, which is why {@link keepSessionAlive} refreshes
 * `lastSeenAt` whenever this cap is set, whether or not an inactivity timeout is — and why it
 * refreshes it only for requests a person made, so an abandoned tab whose stream keeps reconnecting
 * does not outrank the session somebody is working in.
 *
 * `keepSessionId` is never evicted. Without it a cap of one would race with itself: the session
 * just created has the newest stamp, but only by milliseconds, and a clock with coarse resolution
 * could sort it behind an existing one and sign the caller straight back out.
 *
 * Called from the sign-in path rather than from `databaseHooks.session.create.after`, because this
 * deletes rows and that hook may run inside Better Auth's own transaction — a delete there is how a
 * SQLite deadlock is bought.
 *
 * **Called explicitly means it can be forgotten.** Sessions are minted in more places than the two
 * calls here: `changePassword` issues one when `revokeOtherSessions` is set, and the two-factor
 * plugin rotates one on a verified `verifyTOTP` and on `disableTwoFactor`. None of those can take an
 * account over the cap today — each replaces a session rather than adding one, and the two-factor
 * rotations are already followed by a call from `verifyTwoFactor` — but a path that creates a
 * genuinely additional session and does not call this would be over the cap and silently allowed.
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
