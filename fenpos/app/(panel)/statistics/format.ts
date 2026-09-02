/**
 * Plain data shapes and formatting shared between the statistics tabs (server components) and the
 * chart primitives (`charts.tsx`, `"use client"`).
 *
 * No `"use client"` directive — a server component may render a client component, but it cannot
 * *call* a plain function exported from a client module (Next.js's RSC boundary rejects that at
 * request time: "Attempted to call X() from the server but X is on the client"). `formatValue` is
 * called directly by tab server components (e.g. to format a `StatCard`'s value), so it — and the
 * types it and `SeriesSpec` are built from — live here instead, in a module either side can import
 * as an ordinary function/type, not a client reference.
 */

import { describeBytes } from "@/lib/format/bytes";

export interface SeriesSpec {
	key: string;
	label: string;
}

export type ValueFormat = "count" | "ms" | "percent" | "bytes";

/** One value, formatted the way its chart's `valueFormat` says to state it. */
export function formatValue(value: number | string | null | undefined, format?: ValueFormat): string {
	if (value === null || value === undefined) return "–";
	const n = typeof value === "number" ? value : Number(value);
	if (Number.isNaN(n)) return String(value);
	switch (format) {
		case "ms":
			return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
		case "percent":
			return `${Math.round(n * 100)}%`;
		case "bytes":
			return describeBytes(n);
		default:
			return n.toLocaleString();
	}
}
