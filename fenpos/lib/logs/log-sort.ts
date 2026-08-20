import type { LogLevel } from "@/lib/domain/enums";
import type { SortChoice } from "@/lib/table/sort";

/**
 * Severity as a number, which is what both the filter and the Level ordering actually mean.
 *
 * Written to `LogEntry.severity` when a line is recorded, so the database can order and compare
 * it. The level string cannot do either job: sorted, it gives DEBUG, ERROR, INFO, WARN — ERROR
 * second, which looks like severity and is not.
 *
 * Lives here, in a module with no runtime imports, because the three places that write or read it
 * are a server module, a client table and a standalone script, and a copy in each is how they come
 * to disagree.
 */
export const LOG_SEVERITY: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/**
 * The columns the log can be ordered by.
 *
 * Level orders by {@link LOG_SEVERITY} rather than by the level string, so descending really does
 * put errors first. That is the whole reason the severity column exists.
 *
 * Message orders alphabetically, which sorts by whichever word happens to start the line. That is a
 * property of the phrasing rather than of the event, but it does bring every repetition of the same
 * message together, which is what someone reading a printer that has failed forty times wants.
 *
 * Split out from the service because the table imports these too, and the service is `server-only`.
 */
export const LOG_SORT_COLUMNS = ["time", "level", "source", "message"] as const;

/** A column the log can be ordered by. */
export type LogSortColumn = (typeof LOG_SORT_COLUMNS)[number];

/** The ordering used when the URL asks for none: newest first. */
export const LOG_DEFAULT_SORT: SortChoice<LogSortColumn> = { column: "time", desc: true };

/** Whether a value names a column the log can be ordered by. */
export function isLogSortColumn(value: string): value is LogSortColumn {
	return (LOG_SORT_COLUMNS as readonly string[]).includes(value);
}
