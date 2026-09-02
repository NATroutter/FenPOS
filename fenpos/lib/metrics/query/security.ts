import "server-only";
import { auditDb, metricsDb } from "@/lib/db";
import type { MetricsFilter } from "@/lib/metrics/query/series";
import { displayBucket, displayBuckets, type ResolvedRange } from "@/lib/metrics/range";
import { hourStart } from "@/lib/metrics/rollup";

/**
 * The Security tab: sign-ins, denials, the audit category mix, and storage growth.
 *
 * `signIns` and `deniedActions` read `MetricAuthHourly`'s `signin_success`/`signin_failed`/
 * `denied_action` kinds directly, with no rolled/live split: like the API tab's stream, these kinds
 * are written straight from the live in-memory counters (`flushMetricCounters`) rather than rolled
 * from a raw table. `auditCategories`'s `category:*` kinds are different — those are rolled from
 * `auditDb.auditEvent` by the "audit" stream's own watermark (`rollAuditHour`), so that one merges
 * rolled rows with a live count over raw audit events since the watermark, the same split `jobSeries`
 * uses for jobs. Every query here floors its lower bound to the hour for the streams stored in
 * `metricsDb`, the same alignment fix `jobSeries` documents at its rolled query.
 *
 * `failedByIp` reads `auditDb.auditEvent` directly rather than through any rollup — IP address has no
 * hourly aggregate anywhere, so this is a live groupBy bounded by the exact range.
 *
 * `MetricsFilter` does not apply here: none of this data is scoped to an agent or a device.
 */

export interface SecurityTabData {
	signIns: { t: string; success: number; failed: number }[];
	failedByIp: { ip: string; count: number }[];
	deniedActions: { t: string; denied: number }[];
	auditCategories: { t: string; [category: string]: string | number }[];
	activeSessions: { t: string; sessions: number }[];
	storage: { t: string; mainMB: number; auditMB: number; logsMB: number }[];
}

const TOP_CATEGORIES = 6;
const SIGN_IN_ACTION = "auth:sign-in";
const BYTES_PER_MB = 1024 * 1024;

async function auditWatermark(): Promise<Date> {
	const row = await metricsDb.metricWatermark.findUnique({ where: { stream: "audit" } });
	return row ? row.rolledThrough : hourStart(new Date());
}

interface CategoryBucket {
	t: Date;
	byCategory: Map<string, number>;
}

async function categorySeries(range: ResolvedRange): Promise<CategoryBucket[]> {
	const watermark = await auditWatermark();
	const rolledEnd = watermark.getTime() < range.to.getTime() ? watermark : range.to;

	const buckets = new Map<number, CategoryBucket>();
	for (const t of displayBuckets(range)) buckets.set(t.getTime(), { t, byCategory: new Map() });

	function bucketFor(t: Date): CategoryBucket {
		const key = displayBucket(t, range.granularity).getTime();
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { t: new Date(key), byCategory: new Map() };
			buckets.set(key, bucket);
		}
		return bucket;
	}

	function bump(bucket: CategoryBucket, category: string, by: number): void {
		bucket.byCategory.set(category, (bucket.byCategory.get(category) ?? 0) + by);
	}

	const rolledFrom = hourStart(range.from);
	if (rolledEnd.getTime() > rolledFrom.getTime()) {
		const rolled = await metricsDb.metricAuthHourly.findMany({
			where: { bucket: { gte: rolledFrom, lt: rolledEnd }, kind: { startsWith: "category:" } },
		});
		for (const row of rolled) {
			bump(bucketFor(row.bucket), row.kind, row.count);
		}
	}

	if (range.to.getTime() > watermark.getTime()) {
		const events = await auditDb.auditEvent.findMany({
			where: { at: { gte: watermark, lt: range.to } },
			select: { at: true, action: true },
		});
		for (const event of events) {
			bump(bucketFor(event.at), `category:${event.action.split(":")[0]}`, 1);
		}
	}

	return [...buckets.values()].sort((a, b) => a.t.getTime() - b.t.getTime());
}

// `filter` is accepted, not applied — see the module comment — so every tab module shares the same
// `(range, filter)` signature the page shell calls them with.
export async function securityTabData(range: ResolvedRange, filter: MetricsFilter): Promise<SecurityTabData> {
	void filter;

	const [signInRows, deniedRows, categoryBuckets, failedByIpRows, samples] = await Promise.all([
		metricsDb.metricAuthHourly.findMany({
			where: {
				bucket: { gte: hourStart(range.from), lt: range.to },
				kind: { in: ["signin_success", "signin_failed"] },
			},
		}),
		metricsDb.metricAuthHourly.findMany({
			where: { bucket: { gte: hourStart(range.from), lt: range.to }, kind: "denied_action" },
		}),
		categorySeries(range),
		auditDb.auditEvent.groupBy({
			by: ["ipAddress"],
			where: { action: SIGN_IN_ACTION, outcome: { not: "SUCCESS" }, at: { gte: range.from, lt: range.to } },
			_count: { _all: true },
		}),
		metricsDb.fleetSample.findMany({ where: { at: { gte: range.from, lt: range.to } } }),
	]);

	const signInBuckets = new Map<number, { success: number; failed: number }>();
	for (const t of displayBuckets(range)) signInBuckets.set(t.getTime(), { success: 0, failed: 0 });
	for (const row of signInRows) {
		const key = displayBucket(row.bucket, range.granularity).getTime();
		const entry = signInBuckets.get(key) ?? { success: 0, failed: 0 };
		if (row.kind === "signin_success") entry.success += row.count;
		else entry.failed += row.count;
		signInBuckets.set(key, entry);
	}
	const signIns = [...signInBuckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([key, v]) => ({ t: new Date(key).toISOString(), success: v.success, failed: v.failed }));

	const deniedBuckets = new Map<number, number>();
	for (const t of displayBuckets(range)) deniedBuckets.set(t.getTime(), 0);
	for (const row of deniedRows) {
		const key = displayBucket(row.bucket, range.granularity).getTime();
		deniedBuckets.set(key, (deniedBuckets.get(key) ?? 0) + row.count);
	}
	const deniedActions = [...deniedBuckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([key, denied]) => ({ t: new Date(key).toISOString(), denied }));

	const totalByCategory = new Map<string, number>();
	for (const bucket of categoryBuckets) {
		for (const [category, count] of bucket.byCategory) {
			totalByCategory.set(category, (totalByCategory.get(category) ?? 0) + count);
		}
	}
	const topCategories = [...totalByCategory.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, TOP_CATEGORIES)
		.map(([category]) => category);
	const auditCategories = categoryBuckets.map((bucket) => {
		const row: { t: string; [category: string]: string | number } = { t: bucket.t.toISOString() };
		let other = 0;
		for (const [category, count] of bucket.byCategory) {
			if (topCategories.includes(category)) row[category] = count;
			else other += count;
		}
		for (const category of topCategories) {
			if (!(category in row)) row[category] = 0;
		}
		row.other = other;
		return row;
	});

	const failedByIp = failedByIpRows
		.map((row) => ({ ip: row.ipAddress ?? "unknown", count: row._count._all }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 10);

	const sampleBuckets = new Map<
		number,
		{ activeSessions: number; dbMainBytes: number; dbAuditBytes: number; dbLogsBytes: number }[]
	>();
	for (const t of displayBuckets(range)) sampleBuckets.set(t.getTime(), []);
	for (const sample of samples) {
		const key = displayBucket(sample.at, range.granularity).getTime();
		const list = sampleBuckets.get(key);
		const entry = {
			activeSessions: sample.activeSessions,
			dbMainBytes: sample.dbMainBytes,
			dbAuditBytes: sample.dbAuditBytes,
			dbLogsBytes: sample.dbLogsBytes,
		};
		if (list) list.push(entry);
		else sampleBuckets.set(key, [entry]);
	}
	const orderedSamples = [...sampleBuckets.entries()].sort((a, b) => a[0] - b[0]);
	const activeSessions = orderedSamples.map(([key, list]) => ({
		t: new Date(key).toISOString(),
		sessions: list.length ? Math.round(list.reduce((sum, s) => sum + s.activeSessions, 0) / list.length) : 0,
	}));
	const storage = orderedSamples.map(([key, list]) => {
		const avg = (pick: (s: (typeof list)[number]) => number): number =>
			list.length ? list.reduce((sum, s) => sum + pick(s), 0) / list.length / BYTES_PER_MB : 0;
		return {
			t: new Date(key).toISOString(),
			mainMB: avg((s) => s.dbMainBytes),
			auditMB: avg((s) => s.dbAuditBytes),
			logsMB: avg((s) => s.dbLogsBytes),
		};
	});

	return { signIns, failedByIp, deniedActions, auditCategories, activeSessions, storage };
}
