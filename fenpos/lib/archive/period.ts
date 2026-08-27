/**
 * Names the archive period a moment belongs to.
 *
 * UTC rather than the host's zone, deliberately. `compose.yaml` sets `TZ` for user-facing job and
 * log timestamps, but an archive filename that moved when a deployment changed zone would make two
 * files claim the same month and neither hold all of it.
 *
 * @param at the moment to place
 * @returns the period key, e.g. `2026-07`
 */
export function periodKeyFor(at: Date): string {
	return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A period that is due to be archived, and the exclusive boundary that selects exactly its rows. */
export interface PeriodBoundary {
	/** The period's key, e.g. `2026-01`. */
	periodKey: string;
	/** The first instant of the period after this one — what `archivePeriod` takes as `before`. */
	before: Date;
}

/**
 * The whole periods that have aged out, oldest first.
 *
 * Retention is a window in days and archives are calendar months, so the two do not line up. A
 * period is due only when **all** of it is older than the cutoff: archiving the period the cutoff
 * falls inside would file rows that are still inside the retention window, and the archive's name
 * would then cover history the operator was promised was live.
 *
 * The cost is stated where operators read it rather than hidden here: retention keeps up to one
 * period more than the window says, which is the price of archives whose filenames are true.
 *
 * UTC throughout, for the reason {@link periodKeyFor} gives — a boundary that moved with the host's
 * zone would make two files claim the same month and neither hold all of it.
 *
 * An invalid `Date` in either argument is refused rather than absorbed: `NaN` fields never satisfy
 * the wraparound check and `before.getTime() > NaN` is always `false`, so a silent tolerance here
 * would walk forever, pushing periods until the process runs out of memory. That is worse than a
 * thrown error reaching an unattended caller — Task 5 runs this on an hourly timer from a cutoff
 * derived from a stored setting, and a corrupt setting should fail one visible sweep, not hang the
 * container it runs in.
 *
 * @param oldest the oldest row still live; periods before it hold nothing
 * @param cutoff the retention boundary — rows older than this have aged out
 * @returns one entry per due period, oldest first; empty when nothing has fully aged out
 * @throws {Error} if `oldest` or `cutoff` is not a valid `Date`
 */
export function periodsFullyBefore(oldest: Date, cutoff: Date): PeriodBoundary[] {
	if (Number.isNaN(oldest.getTime())) {
		throw new Error("periodsFullyBefore: oldest is an invalid Date");
	}
	if (Number.isNaN(cutoff.getTime())) {
		throw new Error("periodsFullyBefore: cutoff is an invalid Date");
	}

	const due: PeriodBoundary[] = [];

	// The first instant of the month the oldest row is in, then walked forward a month at a time.
	let year = oldest.getUTCFullYear();
	let month = oldest.getUTCMonth();

	for (;;) {
		// The period runs up to, and not including, the first instant of the next month. That instant
		// is both this period's exclusive boundary and the test for whether it has fully aged out.
		const before = new Date(Date.UTC(year, month + 1, 1));
		if (before.getTime() > cutoff.getTime()) {
			return due;
		}

		due.push({ periodKey: `${year}-${String(month + 1).padStart(2, "0")}`, before });

		month += 1;
		if (month === 12) {
			month = 0;
			year += 1;
		}
	}
}
