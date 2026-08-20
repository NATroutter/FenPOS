"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { type EventKind, useEventStream } from "@/components/panel/event-stream";

/**
 * Re-renders the server-component page it sits in whenever the stream reports something that
 * page displays.
 *
 * Pages like Agents and Devices read the connection registry and the database at request time,
 * which is the right way to get the truth — but it makes the page a photograph, while the
 * header's Live chip promises a film. An operator watching an agent pair sees "waiting" until
 * they reload, which is exactly the moment the panel is being watched most closely.
 *
 * Refreshes are coalesced. An agent coming up produces a connect and its first status report
 * within a second of each other, and a busy site produces a log line per job; one refresh
 * covers a burst, and the page cannot be made to re-render per event.
 *
 * Renders nothing. Pausing the header chip stops it, because {@link useEventStream} already
 * ANDs with the live state — a paused panel holds still, refreshes included.
 */
export function LiveRefresh({
	kinds,
	minIntervalMs = 1000,
}: {
	/** The event kinds whose arrival should re-read the page. */
	kinds: EventKind[];
	/** Floor on how often the page is re-fetched, however fast events arrive. */
	minIntervalMs?: number;
}) {
	const refresh = useCoalescedRefresh(minIntervalMs);

	// One subscription component per kind, because a hook cannot be called in a loop whose
	// length may change between renders.
	return (
		<>
			{kinds.map((kind) => (
				<Subscription key={kind} kind={kind} onEvent={refresh} />
			))}
		</>
	);
}

/** Subscribes to a single kind for as long as it is mounted. */
function Subscription({ kind, onEvent }: { kind: EventKind; onEvent: () => void }) {
	useEventStream(kind, onEvent);
	return null;
}

/**
 * A refresh that runs at most once per interval, however many times it is called.
 *
 * @param minIntervalMs the floor between refreshes
 * @returns a function that requests a refresh
 */
function useCoalescedRefresh(minIntervalMs: number): () => void {
	const router = useRouter();
	const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastRefreshedAt = useRef(0);

	useEffect(
		() => () => {
			if (pending.current) {
				clearTimeout(pending.current);
			}
		},
		[],
	);

	return useCallback(() => {
		// A refresh is already on its way; this event will be covered by it.
		if (pending.current) {
			return;
		}
		const wait = Math.max(0, minIntervalMs - (Date.now() - lastRefreshedAt.current));
		pending.current = setTimeout(() => {
			pending.current = null;
			lastRefreshedAt.current = Date.now();
			router.refresh();
		}, wait);
	}, [router, minIntervalMs]);
}
