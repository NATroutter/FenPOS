"use server";

import { type LogsSearchParams, parseLogsSearchParams } from "@/app/(panel)/logs/search-params";
import { panelQuery } from "@/lib/auth/panel-action";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import { type LogLine, listLogs } from "@/lib/logs/log-service";
import { integerSetting } from "@/lib/settings/settings-service";
import { parseOffset } from "@/lib/table/multi-filter";

/**
 * Server actions behind the Logs tab.
 *
 * Just the one, for the same reason it exists on Jobs and Audit: an infinite-scrolled table needs
 * somewhere to ask for the batch after the one the server page rendered.
 */

/** What {@link listMoreLogs} takes: the tab's current filter and sort, plus how many rows are already loaded. */
export interface LogsBatchRequest extends LogsSearchParams {
	offset: unknown;
}

/** What {@link listMoreLogs} hands back. */
export interface LogsBatch {
	lines: LogLine[];
	more: boolean;
	error: string | null;
}

/**
 * Loads the next batch of lines for the Logs tab's infinite scroll.
 *
 * **Re-checks `logs:read` itself, rather than trusting that the page already did.** A server action is
 * a public endpoint reachable by anyone who can construct the POST it compiles to, not only by a
 * browser that first rendered the page behind `requirePagePermission` — the gate here is what actually
 * stops that request, not a formality restating one already run.
 *
 * **Registered `query`**: it runs on every approach to the bottom of the table, and this tab records
 * nothing else at all — a row per scroll would be pure noise in a record that is currently empty of it.
 *
 * **Reuses `listLogs`, the same function the page's own first batch comes from**, narrowed by
 * {@link parseLogsSearchParams} — the same parser the page uses on its own `searchParams` — so a batch
 * the sentinel appends is narrowed exactly as the page's own first batch was.
 *
 * @param request the tab's filter and sort, and how many lines are already on screen
 * @returns the next batch, or an empty one with a reason when it could not be read
 */
export async function listMoreLogs(request: LogsBatchRequest): Promise<LogsBatch> {
	return panelQuery<LogsBatch>(
		"logs:list-more",
		async () => {
			const filter = parseLogsSearchParams(request);
			const pageSize = await integerSetting("panel.logPageSize");
			const page = await listLogs({
				agentId: filter.agentIds,
				apiKeyId: filter.keyIds,
				level: filter.levels,
				from: filter.from,
				to: filter.to,
				sort: filter.sort,
				desc: filter.desc,
				skip: parseOffset(request.offset),
				take: pageSize,
			});
			return { lines: page.lines, more: page.more, error: null };
		},
		{
			refused: () => ({ lines: [], more: false, error: REFUSAL_MESSAGE }),
			failed: () => ({ lines: [], more: false, error: "Something went wrong. Check the server log." }),
		},
	);
}
