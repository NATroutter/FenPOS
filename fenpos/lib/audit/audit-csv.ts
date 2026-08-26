import type { AuditEventSummary } from "@/lib/audit/audit-query";

/**
 * Rendering a filtered range of the record as CSV.
 *
 * Pure — no database, no clock — so the escaping rules can be pinned by tests rather than inferred
 * from what a browser happened to download.
 *
 * **The export is a document built from hostile input.** `actorName` and `actorEmail` are whatever
 * was typed at a sign-in that may never have succeeded, `targetLabel` is a name somebody chose,
 * `detail` carries an action's parameters. All of it is then opened in a spreadsheet — which is why
 * this escapes formulas as well as delimiters. Getting the commas right and the equals signs wrong
 * would produce a file that parses perfectly and runs somebody else's arithmetic.
 *
 * No `server-only`: nothing here touches the database or the request, and keeping it importable from
 * both sides is what would let a future client-side preview share exactly these rules rather than
 * restate them.
 */

/** The columns, in order. `detail` is last because it is by far the longest. */
const COLUMNS = [
	"seq",
	"at",
	"actor",
	"actorKind",
	"actorUserId",
	"actorEmail",
	"action",
	"outcome",
	"targetKind",
	"targetId",
	"targetLabel",
	"ipAddress",
	"userAgent",
	"detail",
] as const satisfies readonly (keyof AuditEventSummary)[];

/**
 * The characters a spreadsheet reads as the start of a formula.
 *
 * Excel and Sheets both execute a cell beginning with one of these on open, with no prompt in the
 * common configurations. `-` is here alongside the obvious three because `-2+3` is arithmetic to a
 * spreadsheet and a perfectly ordinary string to everyone else.
 */
const FORMULA_LEADERS = ["=", "+", "-", "@"];

/** CRLF, because that is what RFC 4180 specifies and what Excel expects. */
const ROW_SEPARATOR = "\r\n";

/**
 * Renders a page of events.
 *
 * @param events the events to export, in the order they should appear
 * @returns the CSV document, header row included
 */
export function toAuditCsv(events: readonly AuditEventSummary[]): string {
	const lines = [COLUMNS.join(",")];
	for (const event of events) {
		lines.push(COLUMNS.map((column) => cell(event[column])).join(","));
	}
	return `${lines.join(ROW_SEPARATOR)}${ROW_SEPARATOR}`;
}

/**
 * Renders one value as a CSV field.
 *
 * Defusing runs before quoting, not after: an apostrophe added to an already-quoted field would land
 * outside the quotes and change what the field is rather than what it starts with.
 *
 * @param value the field's value
 * @returns the field, escaped and quoted as needed
 */
function cell(value: string | number | null): string {
	if (value === null) {
		return "";
	}

	const text = String(value);
	const defused = FORMULA_LEADERS.some((leader) => text.startsWith(leader)) ? `'${text}` : text;

	if (/[",\r\n]/.test(defused)) {
		return `"${defused.replace(/"/g, '""')}"`;
	}
	return defused;
}
