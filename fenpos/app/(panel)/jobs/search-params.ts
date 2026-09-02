import { JobStatus } from "@/lib/domain/enums";
import { isJobSortColumn, type JobSortColumn } from "@/lib/jobs/job-sort";
import { parseKnownValues, parseValues } from "@/lib/table/multi-filter";

/**
 * Reads the Jobs tab's filters and sort, the one way, on both sides of the boundary that matters.
 *
 * The server page parses its `searchParams` with this on the first render; `listMoreJobs`
 * (`actions.ts`) parses its own argument with the same function for every batch the sentinel pulls in
 * after that. They have to agree, because scrolling is supposed to keep narrowing the same list the
 * page opened with — a sentinel that read `status` or `sort` even slightly differently from the page
 * would silently change what "jobs" means partway down the table, and nobody watching it scroll would
 * be able to tell where the seam was.
 *
 * Every field is read as `unknown` rather than trusted as the `string | undefined` the page's own
 * `searchParams` promises. The page's values really are that; a server action's argument is whatever
 * a caller posted to it, which is nothing this module can assume — see `askedArchive` in
 * `archives/actions.ts` for the same discipline applied to that tab's own action argument.
 */

/** The five fields the Jobs tab reads, from either side. */
export interface JobsSearchParams {
	agent?: unknown;
	device?: unknown;
	status?: unknown;
	sort?: unknown;
	dir?: unknown;
}

/** What {@link parseJobsSearchParams} turns the above into — ready for `listJobs`. */
export interface ParsedJobsSearchParams {
	agentIds: string[];
	deviceIds: string[];
	statuses: JobStatus[];
	sort: JobSortColumn | undefined;
	desc: boolean | undefined;
}

/** @returns `value` when it is actually a string, undefined otherwise. */
function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * @param params the filters and sort, from the page's `searchParams` or a `listMoreJobs` call
 * @returns the parsed filter, ready to hand to `listJobs`
 */
export function parseJobsSearchParams(params: JobsSearchParams): ParsedJobsSearchParams {
	const sort = asString(params.sort);
	const dir = asString(params.dir);

	return {
		// Each filter holds as many values as were ticked. An unknown status is dropped rather than
		// erroring, the same reading the sort column below takes.
		agentIds: parseValues(asString(params.agent)),
		deviceIds: parseValues(asString(params.device)),
		statuses: parseKnownValues(asString(params.status), JobStatus.is),
		// An unknown column falls back to the default rather than erroring: a link someone saved before
		// a column was renamed should still list jobs.
		sort: sort && isJobSortColumn(sort) ? sort : undefined,
		desc: dir ? dir !== "asc" : undefined,
	};
}
