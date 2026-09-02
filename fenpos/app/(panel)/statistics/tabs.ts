/**
 * The Statistics page's tabs: identifiers, labels, and (for later tasks) the permission each one
 * needs beyond the page's own `stats:read`.
 *
 * A plain module — no `"use client"`, no `server-only` — for the reason `tab-permits.ts` documents:
 * the client nav strip and the server page and tab switch all need the same list, and a Server
 * Component importing an array out of a `"use client"` module gets a proxy rather than the array
 * itself. Keeping this here, importable from both sides, is what lets `page.tsx` validate `?tab=`
 * and `statistics-nav.tsx` render the strip from one declaration.
 */

/** One tab's identifier, in the order the strip renders them. */
export const TABS = ["overview", "jobs", "reliability", "latency", "fleet", "webhooks", "api", "security"] as const;

export type TabId = (typeof TABS)[number];

/** What each tab is called in the strip and in the placeholder empty state. */
export const TAB_LABELS: Record<TabId, string> = {
	overview: "Overview",
	jobs: "Jobs",
	reliability: "Reliability",
	latency: "Latency",
	fleet: "Fleet",
	webhooks: "Webhooks",
	api: "API",
	security: "Security",
};

/** Narrows an arbitrary string to a known tab. Callers fall back to `"overview"` on `false`. */
export function isTabId(value: string | undefined): value is TabId {
	return value !== undefined && (TABS as readonly string[]).includes(value);
}
