import "server-only";
import { metricsDb, prisma } from "@/lib/db";
import { emptyHistogram, histogramPercentile, mergeInto, parseHistogram } from "@/lib/metrics/histogram";
import type { MetricsFilter } from "@/lib/metrics/query/series";
import { displayBucket, displayBuckets, type ResolvedRange } from "@/lib/metrics/range";
import { hourStart } from "@/lib/metrics/rollup";

/**
 * The API tab: v1 request volume, endpoint/key breakdowns, rejection counts, and response latency.
 *
 * Everything here reads `MetricApiHourly` directly, with no rolled/live split: unlike jobs, this
 * stream is written straight from the live in-memory counters (`flushMetricCounters`, every 60 s)
 * with nothing upstream of it to backfill — there is no raw per-request table this could fall back
 * to for a tail. The query still floors its lower bound to the hour, the same alignment fix
 * `jobSeries` documents at its rolled query: `range.from` is rarely hour-aligned, and comparing it to
 * `bucket` directly would drop the one hourly row whose bucket starts earlier but still overlaps it.
 *
 * `MetricsFilter` does not apply here: API traffic is keyed by route and API key, not by agent or
 * device.
 */

export interface ApiTabData {
	requests: { t: string; ok: number; clientError: number; serverError: number }[];
	byEndpoint: { route: string; count: number }[];
	byKey: { name: string; count: number }[];
	rejections: { t: string; auth: number; rateLimit: number; validation: number }[];
	responsePercentiles: { t: string; p50: number | null; p95: number | null }[];
}

function isRejectRoute(route: string): boolean {
	return route.startsWith("reject:");
}

// `filter` is accepted, not applied — see the module comment — so every tab module shares the same
// `(range, filter)` signature the page shell calls them with.
export async function apiTabData(range: ResolvedRange, filter: MetricsFilter): Promise<ApiTabData> {
	void filter;

	const rows = await metricsDb.metricApiHourly.findMany({
		where: { bucket: { gte: hourStart(range.from), lt: range.to } },
	});

	const buckets = new Map<number, typeof rows>();
	for (const t of displayBuckets(range)) buckets.set(t.getTime(), []);
	for (const row of rows) {
		const key = displayBucket(row.bucket, range.granularity).getTime();
		const list = buckets.get(key);
		if (list) {
			list.push(row);
		} else {
			buckets.set(key, [row]);
		}
	}
	const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]);

	const requests = ordered.map(([key, list]) => {
		let ok = 0;
		let clientError = 0;
		let serverError = 0;
		for (const row of list) {
			if (isRejectRoute(row.route)) continue;
			if (row.statusClass === "2xx") ok += row.count;
			else if (row.statusClass === "4xx") clientError += row.count;
			else if (row.statusClass === "5xx") serverError += row.count;
		}
		return { t: new Date(key).toISOString(), ok, clientError, serverError };
	});

	const rejections = ordered.map(([key, list]) => {
		let auth = 0;
		let rateLimit = 0;
		let validation = 0;
		for (const row of list) {
			if (row.route === "reject:auth") auth += row.count;
			else if (row.route === "reject:rate-limit") rateLimit += row.count;
			else if (row.route === "reject:validation") validation += row.count;
		}
		return { t: new Date(key).toISOString(), auth, rateLimit, validation };
	});

	const responsePercentiles = ordered.map(([key, list]) => {
		const merged = emptyHistogram();
		for (const row of list) {
			if (isRejectRoute(row.route)) continue;
			mergeInto(merged, parseHistogram(row.durationHist));
		}
		return {
			t: new Date(key).toISOString(),
			p50: histogramPercentile(merged, 0.5),
			p95: histogramPercentile(merged, 0.95),
		};
	});

	const byEndpointCounts = new Map<string, number>();
	const byKeyCounts = new Map<string, number>();
	for (const row of rows) {
		if (isRejectRoute(row.route)) continue;
		byEndpointCounts.set(row.route, (byEndpointCounts.get(row.route) ?? 0) + row.count);
		byKeyCounts.set(row.apiKeyId, (byKeyCounts.get(row.apiKeyId) ?? 0) + row.count);
	}
	const byEndpoint = [...byEndpointCounts.entries()]
		.map(([route, count]) => ({ route, count }))
		.sort((a, b) => b.count - a.count);

	const keyIds = [...byKeyCounts.keys()].filter((id) => id !== "");
	const keys = keyIds.length
		? await prisma.apiKey.findMany({ where: { id: { in: keyIds } }, select: { id: true, name: true } })
		: [];
	const keyNames = new Map(keys.map((key) => [key.id, key.name]));
	const byKey = [...byKeyCounts.entries()]
		.map(([id, count]) => ({ name: id === "" ? "(unauthenticated)" : (keyNames.get(id) ?? "(deleted)"), count }))
		.sort((a, b) => b.count - a.count);

	return { requests, byEndpoint, byKey, rejections, responsePercentiles };
}
