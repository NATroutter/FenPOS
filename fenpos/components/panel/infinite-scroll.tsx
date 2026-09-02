"use client";

import { ArrowUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * Infinite scroll for the panel's paged tables — Jobs, Logs, Audit, and the archive reader.
 *
 * **The shape every one of those already returns.** `listJobs`, `listAuditEvents`, `listLogs` and
 * `readArchivePage` all answer a page of rows and whether more follow — see {@link InfiniteBatch}.
 * This file adds nothing to that contract; it gives the pattern a name and a place to live once,
 * rather than four copies of an `IntersectionObserver` each reading the pattern slightly differently.
 *
 * **Batch 0 is the server's, every batch after it is the sentinel's.** Each page's server component
 * still renders the first page — same query, same page size setting as before this feature existed —
 * and hands it to {@link useInfiniteScroll} as `batch`. Scrolling near the bottom asks `loadMore` for
 * the next one and appends it. `batch` itself can change identity later — a `LiveRefresh` subscription
 * or the Logs tab's own "Reload" both call `router.refresh()`, which re-renders the server page and
 * hands this hook a *new* `batch` object — and when that happens batch 0 is replaced wholesale while
 * every appended page is left exactly as it was.
 *
 * **Why replace rather than merge, and why keep the rest stale.** A live install's batch 0 can reorder
 * itself between refreshes — a job moving from PRINTING to COMPLETED changes where it sorts under the
 * default ordering — so diffing it against what was there before is a losing game; taking the fresh
 * copy wholesale is the only version of "batch 0" that is ever actually correct. Re-fetching every
 * appended page on the same refresh would cost one query per page currently on screen for a table that
 * might hold thousands of rows, to freshen rows an operator has already scrolled past and is not
 * looking at. So appended pages are left stale until the operator scrolls further or reloads the tab —
 * an accepted, documented cost, not an oversight.
 *
 * **The one thing that staleness could break, and the guard against it.** A row that sorts into batch
 * 0 on the fresh read while an *older* copy of it is still sitting in an appended page would otherwise
 * render twice. The reconciliation effect below removes exactly that: after batch 0 changes, any
 * appended row sharing an id with a fresh batch-0 row is dropped, so the row survives once, wherever
 * the new data says it belongs.
 *
 * **Resetting on a real filter change is a mount, not a reducer branch.** Changing a filter or the
 * sort re-renders the server page with an entirely different query, and reconciling that against
 * scroll history the way a live refresh is reconciled would mix two unrelated result sets. Every
 * caller of this hook is therefore rendered with `key={...}` built from its own filters and sort, so a
 * real change remounts the component — fresh `appended`, fresh `more` — while `batch`'s identity
 * changing under a *stable* key is what means "the same query, asked again".
 */

/** One page of rows, and whether the caller should ask for another. */
export interface InfiniteBatch<T> {
	rows: T[];
	more: boolean;
}

/** What a `loadMore` call hands back: a batch, plus the reason there is less of it than asked for. */
export interface InfiniteBatchResult<T> extends InfiniteBatch<T> {
	/** Set when the batch could not be (fully) read. The rows already loaded are kept either way. */
	error?: string | null;
}

/** What {@link useInfiniteScroll} hands back. */
export interface InfiniteScrollState<T> {
	/** Batch 0 followed by every appended batch, in order, with the batch-0 dedupe already applied. */
	rows: T[];
	/** Whether another `loadMore` call would return anything. */
	more: boolean;
	/** Whether a `loadMore` call is in flight. */
	loading: boolean;
	/** The last `loadMore` failure, or the batch's own reported error. Null once a call succeeds. */
	error: string | null;
	/** Attach to the element that should trigger the next load as it nears the viewport. */
	sentinelRef: (node: HTMLDivElement | null) => void;
	/** Asks for the next batch by hand — what the footer's Retry button calls. */
	retry: () => void;
	/**
	 * Increments each time `batch` itself is replaced (a live refresh), and only then — appending a
	 * further page does not touch it. A consumer holding state derived from "the current authoritative
	 * snapshot" can use this as a React `key` to reset exactly when that snapshot changes and not when
	 * scrolling merely appends more history under it. The Logs tab's live-arrived-lines buffer is
	 * exactly that state — see `log-list.tsx`.
	 */
	batchVersion: number;
}

/** Read when a `loadMore` call throws rather than resolving with its own error message. */
const FETCH_FAILURE_MESSAGE = "Could not load more rows. Check your connection and try again.";

/**
 * What a batch's own `more` should actually be taken as, once the rows it carries are known.
 *
 * Ordinarily this is just `batch.more` — every batch this hook is handed comes from a `listX` function
 * whose own `more` is `rows.length > take`, which is already correct on its own terms. This exists as
 * the second opinion anyway: a batch of zero rows can never have more behind it, whatever its own
 * `more` claims, because there is nothing in it to have paged forward from. Trusting `more` alone in
 * that one case is exactly the failure mode that leaves a sentinel spinning forever should a caller's
 * `more` and its `rows` ever disagree — a page-size mismatch between two callers of the same `listX`
 * function, for one, is precisely the kind of drift `rows.length > take` stops answering correctly for.
 * Applied both to the seed a caller hands in and to every `loadMore` result, so neither end of this
 * hook's lifetime can get stuck this way.
 */
function settledMore<T>(batch: InfiniteBatch<T>): boolean {
	return batch.rows.length > 0 && batch.more;
}

/**
 * Backs every infinite-scrolling table in the panel. See the module doc for the batch-0 reconciliation
 * this performs and why a real filter change is handled by remounting rather than by a branch here.
 *
 * @param batch the current first page, from the server component that owns this hook's caller
 * @param getId identifies a row, for the dedupe {@link InfiniteBatch}'s replacement requires
 * @param loadMore fetches the batch starting at `offset` rows already loaded
 */
export function useInfiniteScroll<T>({
	batch,
	getId,
	loadMore,
}: {
	batch: InfiniteBatch<T>;
	getId: (row: T) => string;
	loadMore: (offset: number) => Promise<InfiniteBatchResult<T>>;
}): InfiniteScrollState<T> {
	const [appended, setAppended] = useState<T[]>([]);
	const [more, setMore] = useState(() => settledMore(batch));
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [batchVersion, setBatchVersion] = useState(0);

	// Compared by identity on purpose: a caller passes a new `batch` object exactly when the server
	// rendered a fresh one, which is the one event this effect exists to catch. See the module doc.
	//
	// **This is why every caller must hand in a `batch` that is only a new object when the underlying
	// data actually is.** `job-list.tsx`, `audit-list.tsx` and `log-list.tsx` all pass their server
	// prop straight through as `batch` rather than rewrapping it (`{ rows: initial.jobs, ... }`) —
	// their own server prop already carries a stable identity across their own re-renders, and it is
	// the rewrapping that would not. The Archives reader has no server prop to begin with, so it seeds
	// `batch` from a `useRef` created once instead. A `batch` rebuilt as a fresh object literal on every
	// render of the caller would look "new" to this comparison on every render, which would run the
	// effect below, which calls `setState`, which triggers exactly the render that manufactures the
	// next "new" batch — an infinite loop disguised as reconciliation. React's own "Maximum update depth
	// exceeded" is what that looks like from outside; this file's earlier revision had exactly this bug.
	const previousBatch = useRef(batch);
	// A ref rather than relying on `loading` state: state set inside `load` would not be visible to a
	// second call already in flight when it read it, and two overlapping sentinel firings would then
	// both proceed.
	const loadingRef = useRef(false);

	// `getId` is read through a ref, exactly as `useSentinel` reads `onIntersect` below, rather than
	// listed as a dependency of the reconciliation effect. A caller's `getId` is typically an inline
	// arrow (`(job) => job.id`), a fresh function every render; if the effect depended on it directly, an
	// otherwise-stable `batch` would still make the effect re-run on every render — the same infinite
	// loop the `batch` note above describes, from the other input.
	const getIdRef = useRef(getId);
	useEffect(() => {
		getIdRef.current = getId;
	});

	useEffect(() => {
		if (previousBatch.current === batch) {
			return;
		}
		previousBatch.current = batch;
		const freshIds = new Set(batch.rows.map((row) => getIdRef.current(row)));
		// The dedupe: an appended row that now also appears in the fresh batch 0 is dropped from
		// `appended`, so it renders once — wherever the fresh data says it belongs — rather than twice.
		setAppended((current) => current.filter((row) => !freshIds.has(getIdRef.current(row))));
		setMore(settledMore(batch));
		setError(null);
		setBatchVersion((version) => version + 1);
	}, [batch]);

	const rows = batch.rows.concat(appended);
	const rowCount = rows.length;

	const load = useCallback(async () => {
		if (loadingRef.current || !more) {
			return;
		}
		loadingRef.current = true;
		setLoading(true);
		try {
			const next = await loadMore(rowCount);
			setAppended((current) => current.concat(next.rows));
			setMore(settledMore(next));
			setError(next.error ?? null);
		} catch {
			setError(FETCH_FAILURE_MESSAGE);
		} finally {
			loadingRef.current = false;
			setLoading(false);
		}
	}, [loadMore, more, rowCount]);

	const sentinelRef = useSentinel(load, more);

	return { rows, more, loading, error, sentinelRef, retry: load, batchVersion };
}

/**
 * Wires an `IntersectionObserver` to whichever element the returned ref is attached to, firing
 * `onIntersect` once per approach rather than continuously.
 *
 * A ref callback rather than `useRef` plus a `useEffect` reading `.current`: the sentinel is only
 * rendered while `more` is true (see {@link InfiniteScrollFooter}), so the node the observer should
 * watch mounts and unmounts, and a ref callback is React's own signal for exactly that — a plain ref
 * would leave the observer watching a node that has already been removed from the DOM.
 *
 * @param onIntersect called when the sentinel nears the viewport; may change between renders
 * @param active whether there is anything worth observing for right now
 * @returns the ref callback to attach to the sentinel element
 */
function useSentinel(onIntersect: () => void, active: boolean): (node: HTMLDivElement | null) => void {
	const [node, setNode] = useState<HTMLDivElement | null>(null);
	const latest = useRef(onIntersect);
	useEffect(() => {
		latest.current = onIntersect;
	});

	useEffect(() => {
		if (!node || !active) {
			return;
		}
		// A margin ahead of the viewport rather than the viewport itself, so the next batch has already
		// started loading by the time the operator's scroll actually reaches the end of what is drawn.
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					latest.current();
				}
			},
			{ rootMargin: "300px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [node, active]);

	return setNode;
}

/**
 * The sentinel row: a loading spinner while a batch is in flight, the trigger element while more may
 * follow, an error with a retry once one fails, or the terminal "you have reached the end" state.
 *
 * Rendered below the table, in the spot the Older/Newer links used to occupy — the same place, doing
 * the same job of saying whether there is more, without asking the operator to click for it.
 */
export function InfiniteScrollFooter({
	more,
	loading,
	error,
	sentinelRef,
	onRetry,
}: {
	more: boolean;
	loading: boolean;
	error: string | null;
	sentinelRef: (node: HTMLDivElement | null) => void;
	onRetry: () => void;
}) {
	if (error) {
		return (
			<div className="flex flex-wrap items-center justify-center gap-3 py-4 text-[12px] text-destructive">
				<span>{error}</span>
				<Button variant="outline" size="sm" onClick={onRetry}>
					Retry
				</Button>
			</div>
		);
	}

	if (!more) {
		return <p className="py-4 text-center text-[12px] text-subtle-foreground">That is every row.</p>;
	}

	return (
		<div ref={sentinelRef} className="flex items-center justify-center py-4">
			{loading ? <Spinner className="size-4" /> : null}
		</div>
	);
}

/** How far the panel's own scroll container has to move before the button offers to undo it. */
const BACK_TO_TOP_THRESHOLD = 400;

/**
 * Finds the panel's own scroll container.
 *
 * The panel's content does not scroll the window — `app/(panel)/layout.tsx` gives the area below the
 * header `overflow-y-auto` of its own, marked with `data-panel-scroll` for exactly this — so a control
 * that measured or moved `window.scrollY` would read and write the wrong element's position.
 */
function scrollContainer(): HTMLElement | null {
	return document.querySelector<HTMLElement>("[data-panel-scroll]");
}

/**
 * A floating button back to the top of the panel's scroll area, offered once scrolling an
 * infinite list has carried the operator far enough that the Back to top link the old Newer button
 * offered for free is worth replacing with something that does not require scrolling back up by hand.
 *
 * Fixed to the viewport's corner rather than the list's, and hidden until there is somewhere to go —
 * a button that is always present but usually does nothing is a button an operator stops seeing.
 */
export function BackToTop() {
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const container = scrollContainer();
		if (!container) {
			return;
		}
		const onScroll = () => setVisible(container.scrollTop > BACK_TO_TOP_THRESHOLD);
		onScroll();
		container.addEventListener("scroll", onScroll, { passive: true });
		return () => container.removeEventListener("scroll", onScroll);
	}, []);

	return (
		<Button
			variant="outline"
			size="icon"
			title="Back to top"
			aria-label="Back to top"
			onClick={() => scrollContainer()?.scrollTo({ top: 0, behavior: "smooth" })}
			className={cn(
				"fixed right-6 bottom-6 z-40 rounded-full shadow-lg transition-opacity",
				visible ? "opacity-100" : "pointer-events-none opacity-0",
			)}
		>
			<ArrowUp className="size-4" />
		</Button>
	);
}
