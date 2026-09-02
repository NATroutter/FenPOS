import "server-only";
import { prisma } from "@/lib/db";
import {
	addSample,
	BUCKET_BOUNDS_MS,
	emptyHistogram,
	type Histogram,
	histogramPercentile,
	mergeInto,
} from "@/lib/metrics/histogram";
import { jobSeries, type MetricsFilter } from "@/lib/metrics/query/series";
import type { ResolvedRange } from "@/lib/metrics/range";
import { clampedDurationMs } from "@/lib/metrics/rollup-jobs";

/**
 * The Latency tab: percentile trends for queue/print/total duration, the fleet-wide distribution,
 * and the slowest printers.
 *
 * `slowestPrinters` needs a per-device breakdown latency's own rollup rows carry (`MetricJobHourly`
 * is keyed by device), but is computed here from raw jobs instead — jobs are kept forever, and this
 * avoids a second rolled/live merge on top of the one `jobSeries` already does for the fleet-wide
 * percentiles.
 */

export interface LatencyTabData {
	printPercentiles: { t: string; p50: number | null; p95: number | null; p99: number | null }[];
	queuePercentiles: { t: string; p50: number | null; p95: number | null; p99: number | null }[];
	totalPercentiles: { t: string; p50: number | null; p95: number | null; p99: number | null }[];
	distribution: { bucket: string; count: number }[];
	slowestPrinters: { name: string; p95Ms: number | null }[];
	clockSkewCount: number;
}

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];

function percentiles(
	hist: Histogram,
	t: string,
): { t: string; p50: number | null; p95: number | null; p99: number | null } {
	return {
		t,
		p50: histogramPercentile(hist, 0.5),
		p95: histogramPercentile(hist, 0.95),
		p99: histogramPercentile(hist, 0.99),
	};
}

/** Formats one histogram bound as a chart label, e.g. 1000 -> "≤1s", 300000 -> "≤5m". */
function formatBoundLabel(ms: number): string {
	if (ms < 1000) return `≤${ms}ms`;
	if (ms < 60000) {
		const seconds = ms / 1000;
		return `≤${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
	}
	const minutes = ms / 60000;
	return `≤${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
}

export async function latencyTabData(range: ResolvedRange, filter: MetricsFilter): Promise<LatencyTabData> {
	const [series, jobs] = await Promise.all([
		jobSeries(range, filter),
		prisma.job.findMany({
			where: {
				status: { in: TERMINAL_STATUSES },
				...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
				...(filter.agentId ? { agentId: filter.agentId } : {}),
				OR: [
					{ finishedAt: { gte: range.from, lt: range.to } },
					{ finishedAt: null, submittedAt: { gte: range.from, lt: range.to } },
				],
			},
			select: { deviceId: true, device: { select: { name: true } }, startedAt: true, finishedAt: true },
		}),
	]);

	const printPercentiles = series.map((bucket) => percentiles(bucket.printHist, bucket.t.toISOString()));
	const queuePercentiles = series.map((bucket) => percentiles(bucket.queueHist, bucket.t.toISOString()));
	const totalPercentiles = series.map((bucket) => percentiles(bucket.totalHist, bucket.t.toISOString()));

	const mergedPrint = emptyHistogram();
	let clockSkewCount = 0;
	for (const bucket of series) {
		mergeInto(mergedPrint, bucket.printHist);
		clockSkewCount += bucket.clockSkewCount;
	}
	const distribution = [
		...BUCKET_BOUNDS_MS.map((bound, i) => ({ bucket: formatBoundLabel(bound), count: mergedPrint[i] })),
		{ bucket: ">5m", count: mergedPrint[mergedPrint.length - 1] },
	];

	const byDevice = new Map<string, { name: string; hist: Histogram }>();
	for (const job of jobs) {
		const { ms } = clampedDurationMs(job.startedAt, job.finishedAt);
		if (ms === null) continue;
		let entry = byDevice.get(job.deviceId);
		if (!entry) {
			entry = { name: job.device.name, hist: emptyHistogram() };
			byDevice.set(job.deviceId, entry);
		}
		addSample(entry.hist, ms);
	}
	const slowestPrinters = [...byDevice.values()]
		.map((entry) => ({ name: entry.name, p95Ms: histogramPercentile(entry.hist, 0.95) }))
		.sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1));

	return { printPercentiles, queuePercentiles, totalPercentiles, distribution, slowestPrinters, clockSkewCount };
}
