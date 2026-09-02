"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the Statistics page's server component on a fixed interval, while the tab is visible.
 *
 * The page is a photograph taken at request time — `resolveRange` and every rollup query run once,
 * server-side, and nothing here pushes a live update the way `LiveRefresh` does for events. Rather
 * than teach every chart to poll for itself, one timer on the page calls `router.refresh()`, which
 * re-runs `page.tsx` with the same URL and gets a fresh photograph. `stats.autoRefreshSeconds`
 * controls the interval and, at `0`, this component is not mounted at all — see `page.tsx`.
 *
 * `document.visibilityState` gates each tick so a backgrounded tab does not keep re-querying the
 * database for a screen nobody is looking at.
 *
 * Renders nothing.
 */
export function AutoRefresh({ seconds }: { seconds: number }) {
	const router = useRouter();
	useEffect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") router.refresh();
		}, seconds * 1000);
		return () => clearInterval(timer);
	}, [router, seconds]);
	return null;
}
