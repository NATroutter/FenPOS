"use client";

import { type AuditBatchRequest, listMoreAuditEvents } from "@/app/(panel)/audit/actions";
import { AuditTable } from "@/app/(panel)/audit/audit-table";
import {
	BackToTop,
	type InfiniteBatch,
	InfiniteScrollFooter,
	useInfiniteScroll,
} from "@/components/panel/infinite-scroll";
import type { AuditEventSummary } from "@/lib/audit/audit-query";

/**
 * The Audit tab's list, with infinite scroll in place of the old Older/Newer links.
 *
 * See `jobs/job-list.tsx` for the shape this follows — the server page still owns the filters, the
 * sort and the first batch; this appends further ones as the operator scrolls. Rendered with
 * `key={...}` built from the tab's filters and sort by the page itself, so a real change to either
 * remounts this with a clean slate rather than reconciling one query's scroll history against
 * another's.
 *
 * `initial` is handed to `useInfiniteScroll` exactly as received — see `job-list.tsx`'s doc for why
 * rewrapping it in a fresh object here would be an infinite render loop rather than a convenience.
 */
export function AuditList({
	initial,
	query,
}: {
	/** The server page's own first batch. */
	initial: InfiniteBatch<AuditEventSummary>;
	/** The filter and sort to carry into every `listMoreAuditEvents` call, exactly as the URL holds them. */
	query: Omit<AuditBatchRequest, "offset">;
}) {
	const { rows, more, loading, error, sentinelRef, retry } = useInfiniteScroll<AuditEventSummary>({
		batch: initial,
		getId: (event) => String(event.seq),
		loadMore: async (offset) => {
			const page = await listMoreAuditEvents({ ...query, offset });
			return { rows: page.events, more: page.more, error: page.error };
		},
	});

	return (
		<>
			<AuditTable events={rows} />
			{rows.length > 0 ? (
				<InfiniteScrollFooter more={more} loading={loading} error={error} sentinelRef={sentinelRef} onRetry={retry} />
			) : null}
			<BackToTop />
		</>
	);
}
