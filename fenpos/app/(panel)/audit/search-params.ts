import { type AuditSortColumn, isAuditSortColumn } from "@/lib/audit/audit-sort";
import { AuditOutcome } from "@/lib/domain/audit";
import { dayBound } from "@/lib/format/datetime";
import { parseKnownValues, parseValues } from "@/lib/table/multi-filter";

/**
 * Reads the Audit tab's filters and sort, the one way, on both sides of the boundary that matters.
 *
 * The server page parses its `searchParams` with this on the first render; `listMoreAuditEvents`
 * (`actions.ts`) parses its own argument with the same function for every batch the sentinel pulls in
 * after that. See `jobs/search-params.ts`'s doc for why the two have to agree — the same argument
 * applies here, one tab over.
 *
 * **Deliberately not `parseExportFilter`, the Audit tab's other reader of these fields.** That one
 * throws on a date it cannot parse or an outcome it does not recognise, because an export that quietly
 * narrowed to less than it was asked for would hand back a document that looked complete and was not.
 * This one drops what it cannot read instead, because it is read on every scroll rather than on a
 * deliberate button press, and it has to agree with how the *page itself* reads the same parameters —
 * which drops rather than throws, so a bookmark saved before an action or a status was renamed still
 * lists events rather than erroring.
 */

/** The eight fields the Audit tab reads, from either side. */
export interface AuditSearchParams {
	actor?: unknown;
	action?: unknown;
	outcome?: unknown;
	target?: unknown;
	from?: unknown;
	to?: unknown;
	sort?: unknown;
	dir?: unknown;
}

/** What {@link parseAuditSearchParams} turns the above into — ready for `listAuditEvents`. */
export interface ParsedAuditSearchParams {
	actorIds: string[];
	actions: string[];
	outcomes: AuditOutcome[];
	targetIds: string[];
	sort: AuditSortColumn | undefined;
	desc: boolean | undefined;
	from: Date | undefined;
	to: Date | undefined;
}

/** @returns `value` when it is actually a string, undefined otherwise. */
function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * @param params the filters and sort, from the page's `searchParams` or a `listMoreAuditEvents` call
 * @returns the parsed filter, ready to hand to `listAuditEvents`
 */
export function parseAuditSearchParams(params: AuditSearchParams): ParsedAuditSearchParams {
	const sort = asString(params.sort);
	const dir = asString(params.dir);

	return {
		// Each filter holds as many values as were ticked. An unknown one is dropped rather than
		// erroring: a bookmark saved before a column was renamed should still list events.
		actorIds: parseValues(asString(params.actor)),
		actions: parseValues(asString(params.action)),
		outcomes: parseKnownValues(asString(params.outcome), AuditOutcome.is),
		targetIds: parseValues(asString(params.target)),
		sort: sort && isAuditSortColumn(sort) ? sort : undefined,
		desc: dir ? dir !== "asc" : undefined,
		from: dayBound(asString(params.from), "start"),
		to: dayBound(asString(params.to), "end"),
	};
}
