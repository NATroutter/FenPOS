import "server-only";
import { prisma } from "@/lib/db";
import { jobSeries, type MetricsFilter } from "@/lib/metrics/query/series";
import type { ResolvedRange } from "@/lib/metrics/range";

/**
 * The Jobs tab: throughput, source mix, size and timing breakdowns.
 *
 * `sizeDistribution`, `heatmap`, `topPrinters`, `topAgents` and `topKeys` are all computed from raw
 * jobs across the whole range rather than from rollups — jobs are kept forever, so this is exact,
 * and the per-key and per-device breakdowns these need have no rollup equivalent (`MetricJobHourly`
 * carries a name and totals per device, but no `apiKeyId` dimension at all).
 */

export interface JobsTabData {
	jobsOverTime: { t: string; completed: number; failed: number; cancelled: number }[];
	bySource: { t: string; panel: number; api: number }[];
	bytesOverTime: { t: string; bytes: number }[];
	linesOverTime: { t: string; lines: number }[];
	sizeDistribution: { bucket: string; count: number }[];
	heatmap: number[][];
	topPrinters: { name: string; jobs: number }[];
	topAgents: { name: string; jobs: number }[];
	topKeys: { name: string; jobs: number }[];
	averageSize: { t: string; avgBytes: number | null }[];
}

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];

const SIZE_BOUNDS = [256, 1024, 4096, 16384, 65536];
const SIZE_LABELS = ["<256B", "<1K", "<4K", "<16K", "<64K", ">=64K"];

function sizeBucketIndex(bytes: number): number {
	for (let i = 0; i < SIZE_BOUNDS.length; i++) {
		if (bytes < SIZE_BOUNDS[i]) return i;
	}
	return SIZE_LABELS.length - 1;
}

export async function jobsTabData(range: ResolvedRange, filter: MetricsFilter): Promise<JobsTabData> {
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
			select: {
				bytes: true,
				deviceId: true,
				agentId: true,
				apiKeyId: true,
				finishedAt: true,
				submittedAt: true,
				device: { select: { name: true } },
				agent: { select: { name: true } },
			},
		}),
	]);

	const jobsOverTime = series.map((bucket) => ({
		t: bucket.t.toISOString(),
		completed: bucket.completed,
		failed: bucket.failed,
		cancelled: bucket.cancelled,
	}));
	const bySource = series.map((bucket) => ({
		t: bucket.t.toISOString(),
		panel: bucket.panelJobs,
		api: bucket.apiJobs,
	}));
	const bytesOverTime = series.map((bucket) => ({ t: bucket.t.toISOString(), bytes: bucket.bytesTotal }));
	const linesOverTime = series.map((bucket) => ({ t: bucket.t.toISOString(), lines: bucket.linesTotal }));
	const averageSize = series.map((bucket) => {
		const count = bucket.completed + bucket.failed + bucket.cancelled;
		return { t: bucket.t.toISOString(), avgBytes: count > 0 ? bucket.bytesTotal / count : null };
	});

	const sizeCounts = new Array(SIZE_LABELS.length).fill(0);
	const heatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
	const byDevice = new Map<string, { name: string; jobs: number }>();
	const byAgent = new Map<string, { name: string; jobs: number }>();
	const byKey = new Map<string, number>();

	for (const job of jobs) {
		if (job.bytes !== null) {
			sizeCounts[sizeBucketIndex(job.bytes)] += 1;
		}

		const effectiveAt = job.finishedAt ?? job.submittedAt;
		const weekday = (effectiveAt.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
		heatmap[weekday][effectiveAt.getUTCHours()] += 1;

		const deviceEntry = byDevice.get(job.deviceId) ?? { name: job.device.name, jobs: 0 };
		deviceEntry.jobs += 1;
		byDevice.set(job.deviceId, deviceEntry);

		const agentEntry = byAgent.get(job.agentId) ?? { name: job.agent.name, jobs: 0 };
		agentEntry.jobs += 1;
		byAgent.set(job.agentId, agentEntry);

		const keyId = job.apiKeyId ?? "";
		byKey.set(keyId, (byKey.get(keyId) ?? 0) + 1);
	}

	const sizeDistribution = SIZE_LABELS.map((bucket, i) => ({ bucket, count: sizeCounts[i] }));

	const topPrinters = [...byDevice.values()].sort((a, b) => b.jobs - a.jobs).slice(0, 10);
	const topAgents = [...byAgent.values()].sort((a, b) => b.jobs - a.jobs).slice(0, 10);

	const keyIds = [...byKey.keys()].filter((id) => id !== "");
	const keys = keyIds.length
		? await prisma.apiKey.findMany({ where: { id: { in: keyIds } }, select: { id: true, name: true } })
		: [];
	const keyNames = new Map(keys.map((key) => [key.id, key.name]));
	const topKeys = [...byKey.entries()]
		.map(([id, count]) => ({ name: id === "" ? "Panel" : (keyNames.get(id) ?? "(deleted)"), jobs: count }))
		.sort((a, b) => b.jobs - a.jobs)
		.slice(0, 10);

	return {
		jobsOverTime,
		bySource,
		bytesOverTime,
		linesOverTime,
		sizeDistribution,
		heatmap,
		topPrinters,
		topAgents,
		topKeys,
		averageSize,
	};
}
