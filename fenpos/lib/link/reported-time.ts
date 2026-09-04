import "server-only";
import { logger } from "@/lib/logger";

/**
 * Believing an agent about when something happened, but only so far.
 *
 * An agent times its own events, and it should: the moment a printer finished is known on the
 * machine holding the port, not here, and the round trip between them is exactly the error a
 * server-side timestamp would introduce. So `at` arrives on the wire and is written to columns that
 * matter — `startedAt` and `finishedAt`, which the statistics read as durations, and a log line's
 * `ts`, which decides when retention sweeps it.
 *
 * That makes the field worth bounding in both directions, and for two different reasons.
 *
 * A time far in the **past** is how a row is made to disappear: the next retention pass sees a log
 * line dated last year, archives it and deletes it, in a database whose whole purpose is to still be
 * there afterwards. A time far in the **future** is how a row is made permanent: nothing sweeps it,
 * ever. Neither needs a hostile agent — a machine whose clock never synchronised does both — which
 * is the other half of why this clamps rather than refuses. A receipt that printed is a fact worth
 * recording at approximately the right time; dropping it because the till's clock is wrong loses the
 * event and the evidence of the wrong clock together.
 */

/**
 * How far into the past a reported time may reach.
 *
 * Generous, because backdating is sometimes the truthful answer. An agent's job state reconciles on
 * reconnect (`LinkDispatcher`), so a receipt that finished during an overnight outage is reported
 * hours later with the time it actually finished, and squashing that to "an hour ago" would lose a
 * real fact and make every line of the backlog claim the same moment. Log lines never need it —
 * `AgentLog` forwards best-effort and drops what it cannot send rather than queueing it, so a log
 * frame's time is always within milliseconds of now — but the bound is shared and has to fit the
 * caller that does.
 *
 * A day is still far inside `logs.retentionDays` (30 by default), which is what stops backdating
 * being a way to have a line archived and deleted on the next pass.
 */
const PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * How far into the future a reported time may reach.
 *
 * Tight, because there is no honest reason for one. Nothing is reported before it happens, so a
 * forward drift is either a clock that is wrong or a value that was chosen — and the consequence is
 * the same either way: retention sweeps on this column, so a row dated next year is a row nothing
 * ever sweeps. An hour absorbs an unsynchronised clock and nothing else.
 */
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * Reads a time reported by an agent, pulled back to something this server's clock can believe.
 *
 * @param raw the reported timestamp, as it arrived
 * @param what being timed, for the log line when it does not fit
 * @param context extra fields for that line
 * @param now current time; injectable so tests need no clock control
 * @returns the reported time when it is plausible, otherwise the nearest time that is
 */
export function plausibleTime(
	raw: string,
	what: string,
	context: Record<string, unknown> = {},
	now: number = Date.now(),
): Date {
	const reported = new Date(raw).getTime();

	if (Number.isNaN(reported)) {
		// The frame schemas require an ISO timestamp, so this is unreachable from a well-formed frame
		// and is the one case with no salvageable value in it.
		logger.warn(`Unreadable time on a ${what}; using this server's clock`, { ...context, reported: raw });
		return new Date(now);
	}

	const earliest = now - PAST_TOLERANCE_MS;
	const latest = now + FUTURE_TOLERANCE_MS;
	if (reported >= earliest && reported <= latest) {
		return new Date(reported);
	}

	const clamped = reported > latest ? latest : earliest;
	logger.warn(`Implausible time on a ${what}; clamped to this server's clock`, {
		...context,
		reported: raw,
		driftSeconds: Math.round((reported - now) / 1000),
	});
	return new Date(clamped);
}
