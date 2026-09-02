"use client";

import { type JobsBatchRequest, listMoreJobs } from "@/app/(panel)/jobs/actions";
import { JobTable } from "@/app/(panel)/jobs/job-table";
import {
	BackToTop,
	type InfiniteBatch,
	InfiniteScrollFooter,
	useInfiniteScroll,
} from "@/components/panel/infinite-scroll";
import type { JobSummary } from "@/lib/jobs/job-service";

/**
 * The Jobs tab's list, with infinite scroll in place of the old Older/Newer links.
 *
 * The server page still renders the first batch and still owns the filters and sort — both travel
 * down as plain props, unchanged from before this feature existed. This component's only job is
 * turning a scroll near the bottom into a `listMoreJobs` call and handing `JobTable` the rows so far.
 *
 * Rendered with `key={...}` built from the tab's filters and sort by the page itself, so a real change
 * to either remounts this component with a clean slate rather than trying to reconcile one query's
 * scroll history against another's — see `components/panel/infinite-scroll.tsx`'s module doc.
 *
 * **`initial` is handed to `useInfiniteScroll` exactly as received, not wrapped in a new object.**
 * `useInfiniteScroll` tells one server refresh from another by comparing `batch` for identity, and a
 * prop passed straight through keeps the reference the server actually gave this component across
 * every one of its own re-renders — a `{ rows: initial.jobs, ... }` literal rebuilt here would look
 * like a fresh batch on every render regardless, which was exactly the infinite render loop this shape
 * exists to avoid. `initial`'s own field is therefore named `rows` to match {@link InfiniteBatch}
 * directly, rather than `jobs`.
 */
export function JobList({
	initial,
	query,
	live,
	canCancel,
}: {
	/** The server page's own first batch. */
	initial: InfiniteBatch<JobSummary>;
	/** The filter and sort to carry into every `listMoreJobs` call, exactly as the URL holds them. */
	query: Omit<JobsBatchRequest, "offset">;
	live: boolean;
	canCancel: boolean;
}) {
	const { rows, more, loading, error, sentinelRef, retry } = useInfiniteScroll<JobSummary>({
		batch: initial,
		getId: (job) => job.id,
		loadMore: async (offset) => {
			const page = await listMoreJobs({ ...query, offset });
			return { rows: page.jobs, more: page.more, error: page.error };
		},
	});

	return (
		<>
			<JobTable jobs={rows} live={live} canCancel={canCancel} />
			{rows.length > 0 ? (
				<InfiniteScrollFooter more={more} loading={loading} error={error} sentinelRef={sentinelRef} onRetry={retry} />
			) : null}
			<BackToTop />
		</>
	);
}
