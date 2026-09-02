import "server-only";
import { metricsDb, prisma } from "@/lib/db";
import { emptyHistogram, type Histogram, mergeInto, parseHistogram } from "@/lib/metrics/histogram";
import { displayBucket, displayBuckets, type Granularity, type ResolvedRange } from "@/lib/metrics/range";
import { hourStart } from "@/lib/metrics/rollup";
import { computeJobRollup, type JobHourlyRow, type RollupJobInput } from "@/lib/metrics/rollup-jobs";

/**
 * The job time series behind every stats tab's chart: rolled `MetricJobHourly` rows for the
 * settled past, folded together with a live aggregation of raw jobs for the sliver of time since
 * the last rollup pass. Neither side ever double-counts the other — the rolled query is bounded
 * above by the watermark, the live query is bounded below by it.
 */

export interface MetricsFilter {
	agentId?: string;
	deviceId?: string;
}

export interface SeriesPoint {
	t: string;
	[key: string]: string | number | null;
}

export interface JobSeriesBucket {
	t: Date;
	completed: number;
	failed: number;
	cancelled: number;
	panelJobs: number;
	apiJobs: number;
	bytesTotal: number;
	linesTotal: number;
	queueHist: Histogram;
	printHist: Histogram;
	totalHist: Histogram;
	clockSkewCount: number;
}

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];

function emptyBucket(t: Date): JobSeriesBucket {
	return {
		t,
		completed: 0,
		failed: 0,
		cancelled: 0,
		panelJobs: 0,
		apiJobs: 0,
		bytesTotal: 0,
		linesTotal: 0,
		queueHist: emptyHistogram(),
		printHist: emptyHistogram(),
		totalHist: emptyHistogram(),
		clockSkewCount: 0,
	};
}

/** Adds one hourly row's counts and histograms into a display bucket. */
function fold(
	target: JobSeriesBucket,
	row: Pick<
		JobHourlyRow,
		| "completed"
		| "failed"
		| "cancelled"
		| "panelJobs"
		| "apiJobs"
		| "bytesTotal"
		| "linesTotal"
		| "clockSkewCount"
		| "queueHist"
		| "printHist"
		| "totalHist"
	>,
): void {
	target.completed += row.completed;
	target.failed += row.failed;
	target.cancelled += row.cancelled;
	target.panelJobs += row.panelJobs;
	target.apiJobs += row.apiJobs;
	target.bytesTotal += row.bytesTotal;
	target.linesTotal += row.linesTotal;
	target.clockSkewCount += row.clockSkewCount;
	mergeInto(target.queueHist, parseHistogram(row.queueHist));
	mergeInto(target.printHist, parseHistogram(row.printHist));
	mergeInto(target.totalHist, parseHistogram(row.totalHist));
}

/** The "jobs" stream's watermark: the start of the first hour not yet rolled. */
export async function jobsWatermark(): Promise<Date> {
	const row = await metricsDb.metricWatermark.findUnique({ where: { stream: "jobs" } });
	return row ? row.rolledThrough : hourStart(new Date());
}

/**
 * The merged job series for `range`, re-bucketed to `range.granularity`, zero-filled across every
 * display bucket in the range.
 *
 * Rolled rows cover `[hourStart(range.from), min(watermark, range.to))` — the lower bound is
 * floored to the hour so the rollup row straddling `range.from` isn't dropped just because its
 * bucket starts a little earlier. A live aggregation over raw terminal jobs (grouped by effective
 * hour and rolled up with {@link computeJobRollup}, the exact function the background job uses)
 * covers `[watermark, range.to)` — the watermark is always hour-aligned already, so no equivalent
 * flooring is needed there. That split is what keeps a job from being counted on both sides of the
 * watermark.
 */
export async function jobSeries(range: ResolvedRange, filter: MetricsFilter): Promise<JobSeriesBucket[]> {
	const watermark = await jobsWatermark();
	const rolledEnd = watermark.getTime() < range.to.getTime() ? watermark : range.to;

	const buckets = new Map<number, JobSeriesBucket>();
	for (const t of displayBuckets(range)) {
		buckets.set(t.getTime(), emptyBucket(t));
	}

	function bucketFor(t: Date, granularity: Granularity): JobSeriesBucket {
		const key = displayBucket(t, granularity).getTime();
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = emptyBucket(new Date(key));
			buckets.set(key, bucket);
		}
		return bucket;
	}

	// The rollup table's bucket column is always hour-aligned, but `range.from` (a preset's
	// "now minus a span", or a custom range's start-of-day) almost never is. Comparing the raw
	// value would drop the one hourly row whose bucket starts before `range.from` but whose hour
	// still overlaps it — so the lower bound is floored to the hour first.
	const rolledFrom = hourStart(range.from);

	if (rolledEnd.getTime() > rolledFrom.getTime()) {
		const rolled = await metricsDb.metricJobHourly.findMany({
			where: {
				bucket: { gte: rolledFrom, lt: rolledEnd },
				...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
				...(filter.agentId ? { agentId: filter.agentId } : {}),
			},
		});
		for (const row of rolled) {
			fold(bucketFor(row.bucket, range.granularity), row);
		}
	}

	if (range.to.getTime() > watermark.getTime()) {
		const jobs = await prisma.job.findMany({
			where: {
				status: { in: TERMINAL_STATUSES },
				...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
				...(filter.agentId ? { agentId: filter.agentId } : {}),
				OR: [
					{ finishedAt: { gte: watermark, lt: range.to } },
					{ finishedAt: null, submittedAt: { gte: watermark, lt: range.to } },
				],
			},
			include: {
				device: { select: { name: true } },
				agent: { select: { name: true } },
			},
		});

		const byRawHour = new Map<number, RollupJobInput[]>();
		for (const job of jobs) {
			const effectiveAt = job.finishedAt ?? job.submittedAt;
			const rawHour = hourStart(effectiveAt).getTime();
			const inputs = byRawHour.get(rawHour) ?? [];
			inputs.push({
				deviceId: job.deviceId,
				agentId: job.agentId,
				deviceName: job.device.name,
				agentName: job.agent.name,
				status: job.status,
				submittedAt: job.submittedAt,
				startedAt: job.startedAt,
				finishedAt: job.finishedAt,
				bytes: job.bytes,
				lines: job.lines,
				apiKeyId: job.apiKeyId,
				errorCode: job.errorCode,
			});
			byRawHour.set(rawHour, inputs);
		}

		for (const [rawHour, inputs] of byRawHour) {
			const { jobRows } = computeJobRollup(new Date(rawHour), inputs);
			for (const row of jobRows) {
				fold(bucketFor(row.bucket, range.granularity), row);
			}
		}
	}

	return [...buckets.values()].sort((a, b) => a.t.getTime() - b.t.getTime());
}
