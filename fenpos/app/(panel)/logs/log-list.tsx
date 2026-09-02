"use client";

import { type LogsBatchRequest, listMoreLogs } from "@/app/(panel)/logs/actions";
import { LogStream } from "@/app/(panel)/logs/log-stream";
import { BackToTop, InfiniteScrollFooter, useInfiniteScroll } from "@/components/panel/infinite-scroll";
import type { LogLine } from "@/lib/logs/log-service";

/**
 * The Logs tab's list, with infinite scroll in place of the old Older/Newer links.
 *
 * See `jobs/job-list.tsx` for the shape this follows. This one carries one extra wrinkle: `LogStream`
 * keeps its own buffer of lines that arrived live over the event stream, and clears it whenever its
 * `lines` prop changes — reading that as "a fresh authoritative snapshot arrived; whatever was in
 * `arrived` is already reflected in it." That reading holds for a genuine batch-0 replacement (a
 * `router.refresh()`, from `LogStream`'s own Reload button), because those arrived lines are already
 * in the database and a fresh read of batch 0 includes them. **It does not hold for the sentinel
 * appending an older page**, which shares nothing with what just arrived live — clearing `arrived`
 * then would silently drop lines the operator has not seen yet.
 *
 * So `LogStream`'s own `resetOn` prop is given `batchVersion` here, rather than left to default to
 * `lines`: `useInfiniteScroll` increments `batchVersion` only on a real batch-0 replacement, so a
 * scroll-triggered append changes `lines` without changing `batchVersion` and leaves `arrived` alone,
 * while a live refresh changes both and clears it — exactly the distinction `LogStream` cannot draw
 * from `lines` alone.
 */
export function LogList({
	initial,
	query,
}: {
	/** The server page's own first batch. */
	initial: { lines: LogLine[]; more: boolean };
	/** The filter and sort to carry into every `listMoreLogs` call, exactly as the URL holds them. */
	query: Omit<LogsBatchRequest, "offset">;
}) {
	const { rows, more, loading, error, sentinelRef, retry, batchVersion } = useInfiniteScroll<LogLine>({
		batch: { rows: initial.lines, more: initial.more },
		getId: (line) => line.id,
		loadMore: async (offset) => {
			const page = await listMoreLogs({ ...query, offset });
			return { rows: page.lines, more: page.more, error: page.error };
		},
	});

	return (
		<>
			<LogStream lines={rows} resetOn={batchVersion} />
			{rows.length > 0 ? (
				<InfiniteScrollFooter more={more} loading={loading} error={error} sentinelRef={sentinelRef} onRetry={retry} />
			) : null}
			<BackToTop />
		</>
	);
}
