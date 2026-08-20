import type { SortChoice } from "@/lib/table/sort";

/**
 * The columns the jobs list can be ordered by.
 *
 * A closed set, because the name reaches `orderBy` and the difference between "an ordering we
 * offer" and "whatever the query string said" is the difference between a feature and an injection
 * point. Anything unrecognised falls back to the default rather than erroring — a stale bookmark
 * should still show jobs.
 *
 * The job identifier is absent on purpose. It is a cuid, so ordering by it is neither creation
 * order nor anything a reader could predict: offering it would be offering a shuffle.
 *
 * Split out from the service because the table needs these too, and the service imports
 * `server-only`. Nothing here imports anything with a runtime cost.
 */
export const JOB_SORT_COLUMNS = ["submitted", "status", "lines", "bytes", "printer"] as const;

/** A column the jobs list can be ordered by. */
export type JobSortColumn = (typeof JOB_SORT_COLUMNS)[number];

/** The ordering used when the URL asks for none: newest first. */
export const JOB_DEFAULT_SORT: SortChoice<JobSortColumn> = { column: "submitted", desc: true };

/** Whether a value names a column the jobs list can be ordered by. */
export function isJobSortColumn(value: string): value is JobSortColumn {
	return (JOB_SORT_COLUMNS as readonly string[]).includes(value);
}
