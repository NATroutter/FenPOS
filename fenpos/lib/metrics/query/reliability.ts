import "server-only";
import { metricsDb, prisma } from "@/lib/db";
import { jobSeries, jobsWatermark, type MetricsFilter } from "@/lib/metrics/query/series";
import { displayBucket, displayBuckets, type ResolvedRange } from "@/lib/metrics/range";
import { hourStart } from "@/lib/metrics/rollup";

/**
 * The Reliability tab: success/cancellation rates, and the error-code breakdown.
 *
 * `byErrorCode`/`errorMix`/`errorTable` are built from `MetricErrorHourly` (the settled past) merged
 * with a live count over raw failed jobs (the sliver since the jobs watermark) — the same
 * rolled/live split `jobSeries` uses, applied to the error stream instead. `errorTable.lastSeen` is
 * deliberately not bounded to the selected range: jobs are kept forever, so the true last occurrence
 * of a code is worth reporting even when it falls outside the chart.
 */

export interface ReliabilityTabData {
	successRate: { t: string; rate: number | null }[];
	byErrorCode: { code: string; count: number }[];
	errorMix: { t: string; [code: string]: string | number }[];
	cancellationRate: { t: string; rate: number | null }[];
	failuresByPrinter: { name: string; failed: number }[];
	errorTable: { code: string; count: number; lastSeen: string | null; spark: { t: string; v: number }[] }[];
}

const TOP_ERROR_MIX_CODES = 5;

interface ErrorBucket {
	t: Date;
	byCode: Map<string, number>;
}

async function errorSeries(range: ResolvedRange, filter: MetricsFilter): Promise<ErrorBucket[]> {
	const watermark = await jobsWatermark();
	const rolledEnd = watermark.getTime() < range.to.getTime() ? watermark : range.to;

	const buckets = new Map<number, ErrorBucket>();
	for (const t of displayBuckets(range)) buckets.set(t.getTime(), { t, byCode: new Map() });

	function bucketFor(t: Date): ErrorBucket {
		const key = displayBucket(t, range.granularity).getTime();
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { t: new Date(key), byCode: new Map() };
			buckets.set(key, bucket);
		}
		return bucket;
	}

	function bump(bucket: ErrorBucket, code: string, by: number): void {
		bucket.byCode.set(code, (bucket.byCode.get(code) ?? 0) + by);
	}

	const rolledFrom = hourStart(range.from);
	if (rolledEnd.getTime() > rolledFrom.getTime()) {
		const rolled = await metricsDb.metricErrorHourly.findMany({
			where: {
				bucket: { gte: rolledFrom, lt: rolledEnd },
				...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
				...(filter.agentId ? { agentId: filter.agentId } : {}),
			},
		});
		for (const row of rolled) {
			bump(bucketFor(row.bucket), row.errorCode, row.count);
		}
	}

	if (range.to.getTime() > watermark.getTime()) {
		const jobs = await prisma.job.findMany({
			where: {
				status: "FAILED",
				errorCode: { not: null },
				...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
				...(filter.agentId ? { agentId: filter.agentId } : {}),
				OR: [
					{ finishedAt: { gte: watermark, lt: range.to } },
					{ finishedAt: null, submittedAt: { gte: watermark, lt: range.to } },
				],
			},
			select: { errorCode: true, finishedAt: true, submittedAt: true },
		});
		for (const job of jobs) {
			const effectiveAt = job.finishedAt ?? job.submittedAt;
			bump(bucketFor(effectiveAt), job.errorCode as string, 1);
		}
	}

	return [...buckets.values()].sort((a, b) => a.t.getTime() - b.t.getTime());
}

export async function reliabilityTabData(range: ResolvedRange, filter: MetricsFilter): Promise<ReliabilityTabData> {
	const [series, errBuckets, failedByDevice] = await Promise.all([
		jobSeries(range, filter),
		errorSeries(range, filter),
		prisma.job.groupBy({
			by: ["deviceId"],
			where: {
				status: "FAILED",
				...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
				...(filter.agentId ? { agentId: filter.agentId } : {}),
				OR: [
					{ finishedAt: { gte: range.from, lt: range.to } },
					{ finishedAt: null, submittedAt: { gte: range.from, lt: range.to } },
				],
			},
			_count: { _all: true },
		}),
	]);

	const successRate = series.map((bucket) => {
		const denom = bucket.completed + bucket.failed;
		return { t: bucket.t.toISOString(), rate: denom > 0 ? bucket.completed / denom : null };
	});
	const cancellationRate = series.map((bucket) => {
		const denom = bucket.completed + bucket.failed + bucket.cancelled;
		return { t: bucket.t.toISOString(), rate: denom > 0 ? bucket.cancelled / denom : null };
	});

	const totalByCode = new Map<string, number>();
	for (const bucket of errBuckets) {
		for (const [code, count] of bucket.byCode) {
			totalByCode.set(code, (totalByCode.get(code) ?? 0) + count);
		}
	}
	const byErrorCode = [...totalByCode.entries()]
		.map(([code, count]) => ({ code, count }))
		.sort((a, b) => b.count - a.count);

	const topCodes = byErrorCode.slice(0, TOP_ERROR_MIX_CODES).map((row) => row.code);
	const errorMix = errBuckets.map((bucket) => {
		const row: { t: string; [code: string]: string | number } = { t: bucket.t.toISOString() };
		let otherCount = 0;
		for (const [code, count] of bucket.byCode) {
			if (topCodes.includes(code)) {
				row[code] = count;
			} else {
				otherCount += count;
			}
		}
		for (const code of topCodes) {
			if (!(code in row)) row[code] = 0;
		}
		row.other = otherCount;
		return row;
	});

	const devices = failedByDevice.length
		? await prisma.device.findMany({
				where: { id: { in: failedByDevice.map((row) => row.deviceId) } },
				select: { id: true, name: true },
			})
		: [];
	const deviceNames = new Map(devices.map((device) => [device.id, device.name]));
	const failuresByPrinter = failedByDevice
		.map((row) => ({ name: deviceNames.get(row.deviceId) ?? "(deleted)", failed: row._count._all }))
		.sort((a, b) => b.failed - a.failed);

	const codes = byErrorCode.map((row) => row.code);
	const lastSeenRows = codes.length
		? await prisma.job.groupBy({
				by: ["errorCode"],
				where: {
					status: "FAILED",
					errorCode: { in: codes },
					...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
					...(filter.agentId ? { agentId: filter.agentId } : {}),
				},
				_max: { finishedAt: true },
			})
		: [];
	const lastSeenMap = new Map(lastSeenRows.map((row) => [row.errorCode as string, row._max.finishedAt]));

	const errorTable = byErrorCode.map(({ code, count }) => ({
		code,
		count,
		lastSeen: lastSeenMap.get(code)?.toISOString() ?? null,
		spark: errBuckets.map((bucket) => ({ t: bucket.t.toISOString(), v: bucket.byCode.get(code) ?? 0 })),
	}));

	return { successRate, byErrorCode, errorMix, cancellationRate, failuresByPrinter, errorTable };
}
