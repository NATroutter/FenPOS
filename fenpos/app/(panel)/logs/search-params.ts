import type { LogLevel } from "@/lib/domain/enums";
import { dayBound } from "@/lib/format/datetime";
import { isFilterableLevel } from "@/lib/logs/log-service";
import { isLogSortColumn, type LogSortColumn } from "@/lib/logs/log-sort";
import { parseKnownValues, parseValues } from "@/lib/table/multi-filter";

/**
 * Reads the Logs tab's filters and sort, the one way, on both sides of the boundary that matters.
 *
 * The server page parses its `searchParams` with this on the first render; `listMoreLogs`
 * (`actions.ts`) parses its own argument with the same function for every batch the sentinel pulls in
 * after that. See `jobs/search-params.ts`'s doc for why the two have to agree — the same argument
 * applies here, one tab over.
 */

/** The seven fields the Logs tab reads, from either side. */
export interface LogsSearchParams {
	agent?: unknown;
	key?: unknown;
	level?: unknown;
	from?: unknown;
	to?: unknown;
	sort?: unknown;
	dir?: unknown;
}

/** What {@link parseLogsSearchParams} turns the above into — ready for `listLogs`. */
export interface ParsedLogsSearchParams {
	agentIds: string[];
	keyIds: string[];
	levels: LogLevel[];
	sort: LogSortColumn | undefined;
	desc: boolean | undefined;
	from: Date | undefined;
	to: Date | undefined;
}

/** @returns `value` when it is actually a string, undefined otherwise. */
function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * @param params the filters and sort, from the page's `searchParams` or a `listMoreLogs` call
 * @returns the parsed filter, ready to hand to `listLogs`
 */
export function parseLogsSearchParams(params: LogsSearchParams): ParsedLogsSearchParams {
	const sort = asString(params.sort);
	const dir = asString(params.dir);

	return {
		// Each filter holds as many values as were ticked. Anything else — including `DEBUG`, which the
		// dropdown has never offered — is dropped, so a stale bookmark cannot put a value in a trigger
		// the dropdown has no label for.
		agentIds: parseValues(asString(params.agent)),
		keyIds: parseValues(asString(params.key)),
		levels: parseKnownValues(asString(params.level), isFilterableLevel),
		sort: sort && isLogSortColumn(sort) ? sort : undefined,
		desc: dir ? dir !== "asc" : undefined,
		from: dayBound(asString(params.from), "start"),
		to: dayBound(asString(params.to), "end"),
	};
}
