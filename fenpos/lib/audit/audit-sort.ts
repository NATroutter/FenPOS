import type { SortChoice } from "@/lib/table/sort";

/**
 * The columns the audit list can be ordered by.
 *
 * A closed set, because the name reaches `orderBy` and the difference between "an ordering we offer"
 * and "whatever the query string said" is the difference between a feature and an injection point.
 * Anything unrecognised falls back to the default rather than erroring — a stale bookmark should
 * still list events.
 *
 * **`at` orders by `seq`, not by the timestamp column.** They are near enough the same order and
 * `seq` is the stronger one: it is the chain's own ordering and it is unique, so it needs no
 * tiebreak, while two rows sharing an `at` millisecond could swap between one page view and the
 * next — which on a paged list shows a row twice and hides another. The column keeps the name a
 * reader is thinking in.
 *
 * Split out from the service because the table needs these too, and the service imports
 * `server-only`. Nothing here has a runtime cost.
 */
export const AUDIT_SORT_COLUMNS = ["at", "action", "actor", "outcome"] as const;

/** A column the audit list can be ordered by. */
export type AuditSortColumn = (typeof AUDIT_SORT_COLUMNS)[number];

/** The ordering used when the URL asks for none: newest first. */
export const AUDIT_DEFAULT_SORT: SortChoice<AuditSortColumn> = { column: "at", desc: true };

/** Whether a value names a column the audit list can be ordered by. */
export function isAuditSortColumn(value: string): value is AuditSortColumn {
	return (AUDIT_SORT_COLUMNS as readonly string[]).includes(value);
}
