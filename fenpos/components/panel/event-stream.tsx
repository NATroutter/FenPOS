"use client";

import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * The panel's single connection to `/api/events`, and the live/pause switch that governs it.
 *
 * **One `EventSource` for the whole panel, not one per component.** Each tab used to open its
 * own, which meant the browser held several copies of a stream carrying identical events, and —
 * more importantly — there was nothing a single control could turn off. Pausing has to stop the
 * work rather than hide its results, and that is only meaningful if there is one subscription to
 * stop. The header chip closes this connection; nothing is buffered while it is shut, because a
 * paused operator wants the page to hold still, and what they missed is a reload away.
 *
 * The provider lives in the panel layout, which the app router keeps mounted across navigation,
 * so the choice survives moving between tabs without being persisted anywhere.
 */

/** The event names the stream publishes, matching `PanelEvent["kind"]` on the server. */
export type EventKind = "job" | "log" | "agent" | "device";

/** Handlers receive the raw message so each consumer parses only the payload it cares about. */
type Handler = (event: MessageEvent) => void;

interface EventStream {
	/** Whether the stream is currently connected. */
	live: boolean;
	/** Opens or closes the stream for every consumer at once. */
	setLive: (live: boolean) => void;
	/** Registers a handler for one event kind; returns a function that removes it. */
	subscribe: (kind: EventKind, handler: Handler) => () => void;
}

const EventStreamContext = createContext<EventStream | null>(null);

/** Every kind is listened for once, and fanned out to whichever components are interested. */
const KINDS: EventKind[] = ["job", "log", "agent", "device"];

export function EventStreamProvider({ children }: { children: ReactNode }) {
	const [live, setLive] = useState(true);
	const router = useRouter();

	// Handlers are held in a ref rather than state because a component subscribing must not
	// reopen the connection — the listeners below read this map at dispatch time, so a late
	// subscriber is picked up by the stream that is already running.
	const handlers = useRef<Map<EventKind, Set<Handler>>>(new Map());

	const subscribe = useCallback((kind: EventKind, handler: Handler) => {
		let registered = handlers.current.get(kind);
		if (!registered) {
			registered = new Set();
			handlers.current.set(kind, registered);
		}
		registered.add(handler);

		return () => {
			registered.delete(handler);
		};
	}, []);

	useEffect(() => {
		if (!live) {
			return;
		}

		const source = new EventSource("/api/events");
		for (const kind of KINDS) {
			source.addEventListener(kind, (event) => {
				// Copied before iterating: a handler that unsubscribes itself would otherwise
				// mutate the set mid-dispatch.
				for (const handler of [...(handlers.current.get(kind) ?? [])]) {
					handler(event as MessageEvent);
				}
			});
		}

		// The server drops events rather than queue them without limit for a connection that has
		// stopped being read — a suspended laptop, a proxy that wedged, a tab the browser froze. When
		// reading resumes it says so, and the only honest repair for a gap in a live view is to read
		// the pages again: every consumer of this stream renders server state, so a refresh is exactly
		// what the missed events would have produced.
		source.addEventListener("resync", () => router.refresh());

		return () => source.close();
	}, [live, router]);

	const value = useMemo<EventStream>(() => ({ live, setLive, subscribe }), [live, subscribe]);

	return <EventStreamContext.Provider value={value}>{children}</EventStreamContext.Provider>;
}

function useEventStreamContext(): EventStream {
	const context = useContext(EventStreamContext);
	if (!context) {
		throw new Error("useEventStream must be used inside EventStreamProvider");
	}
	return context;
}

/** Reads and sets the live/pause state. For the header chip. */
export function useLive(): { live: boolean; setLive: (live: boolean) => void } {
	const { live, setLive } = useEventStreamContext();
	return { live, setLive };
}

/**
 * Subscribes to one kind of event for as long as the component is mounted and the stream is on.
 *
 * @param kind which events to receive
 * @param handler called with the raw message; may change between renders without resubscribing
 * @param enabled the caller's own condition, ANDed with the header's live state — the Logs tab
 *   uses it to stop streaming while a filter is applied, since lines arriving unfiltered would
 *   contradict what the filter says the view contains
 */
export function useEventStream(kind: EventKind, handler: Handler, enabled = true): void {
	const { live, subscribe } = useEventStreamContext();

	// The latest handler is read through a ref so that a caller passing an inline closure — which
	// is a different function on every render — does not resubscribe on every render.
	const latest = useRef(handler);
	useEffect(() => {
		latest.current = handler;
	});

	useEffect(() => {
		if (!enabled || !live) {
			return;
		}
		return subscribe(kind, (event) => latest.current(event));
	}, [kind, enabled, live, subscribe]);
}
