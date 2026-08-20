/**
 * The vocabulary a sortable list shares between its server and its table.
 *
 * Deliberately free of imports, and in particular free of `server-only`. The column names and the
 * default ordering are needed in both places — the service turns them into an `orderBy`, the table
 * renders arrows from them — and a module the client cannot import would force the table to
 * restate them, which is how the two drift into disagreeing about what `?sort=` means.
 */

/** Which way round an ordering runs. */
export type SortDirection = "asc" | "desc";

/** A column and a direction, as a list falls back to when the URL names none. */
export interface SortChoice<TColumn extends string> {
	column: TColumn;
	desc: boolean;
}
