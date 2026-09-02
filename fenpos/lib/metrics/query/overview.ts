import "server-only";
import { metricsDb, prisma } from "@/lib/db";
import { getAgentStatus } from "@/lib/link/device-status";
import { connectedAgentIds } from "@/lib/link/registry";
import { emptyHistogram, histogramPercentile, mergeInto } from "@/lib/metrics/histogram";
import { jobSeries, type MetricsFilter } from "@/lib/metrics/query/series";
import { displayBucket, displayBuckets, type ResolvedRange } from "@/lib/metrics/range";

/**
 * The Overview tab: the headline cards and the four charts that back them.
 *
 * The "live" cards (agentsOnline, printersConnected, queueDepth) read the in-memory registry and a
 * fresh job count, exactly the way `app/(panel)/dashboard/page.tsx` does — they answer "right now",
 * not "as of the last fleet sample".
 */

export interface OverviewTabData {
	cards: {
		jobs: { value: number; spark: { t: string; v: number }[] };
		successRate: { value: number | null; spark: { t: string; v: number | null }[] };
		printP50Ms: { value: number | null; spark: { t: string; v: number | null }[] };
		agentsOnline: { online: number; total: number };
		printersConnected: { connected: number; total: number };
		queueDepth: number;
	};
	jobsOverTime: { t: string; completed: number; failed: number; cancelled: number }[];
	availability: { t: string; agentsOnline: number; agentsTotal: number }[];
	failuresOverTime: { t: string; failed: number }[];
}

export async function overviewTabData(range: ResolvedRange, filter: MetricsFilter): Promise<OverviewTabData> {
	const [series, agents, devices, queueDepth, samples] = await Promise.all([
		jobSeries(range, filter),
		prisma.agent.findMany({
			where: filter.agentId ? { id: filter.agentId } : {},
			select: { id: true },
		}),
		prisma.device.findMany({
			where: {
				...(filter.deviceId ? { id: filter.deviceId } : {}),
				...(filter.agentId ? { agentId: filter.agentId } : {}),
			},
			select: { agentId: true, name: true },
		}),
		prisma.job.count({
			where: {
				status: { in: ["QUEUED", "PRINTING"] },
				...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
				...(filter.agentId ? { agentId: filter.agentId } : {}),
			},
		}),
		metricsDb.fleetSample.findMany({ where: { at: { gte: range.from, lt: range.to } } }),
	]);

	const online = new Set(connectedAgentIds());
	const agentsOnline = agents.filter((agent) => online.has(agent.id)).length;
	const printersConnected = devices.filter(
		(device) => getAgentStatus(device.agentId).get(device.name)?.connection === "CONNECTED",
	).length;

	let totalCompleted = 0;
	let totalFailed = 0;
	let totalCancelled = 0;
	const jobsOverTime = series.map((bucket) => {
		totalCompleted += bucket.completed;
		totalFailed += bucket.failed;
		totalCancelled += bucket.cancelled;
		return {
			t: bucket.t.toISOString(),
			completed: bucket.completed,
			failed: bucket.failed,
			cancelled: bucket.cancelled,
		};
	});

	const jobsSpark = series.map((bucket) => ({
		t: bucket.t.toISOString(),
		v: bucket.completed + bucket.failed + bucket.cancelled,
	}));
	const totalJobs = totalCompleted + totalFailed + totalCancelled;

	const successRateSpark = series.map((bucket) => {
		const denom = bucket.completed + bucket.failed;
		return { t: bucket.t.toISOString(), v: denom > 0 ? bucket.completed / denom : null };
	});
	const successDenom = totalCompleted + totalFailed;
	const successRateValue = successDenom > 0 ? totalCompleted / successDenom : null;

	const printP50Spark = series.map((bucket) => ({
		t: bucket.t.toISOString(),
		v: histogramPercentile(bucket.printHist, 0.5),
	}));
	const mergedPrint = emptyHistogram();
	for (const bucket of series) mergeInto(mergedPrint, bucket.printHist);
	const printP50Value = histogramPercentile(mergedPrint, 0.5);

	const failuresOverTime = series.map((bucket) => ({ t: bucket.t.toISOString(), failed: bucket.failed }));

	const buckets = new Map<number, { agentsOnline: number; agentsTotal: number }[]>();
	for (const t of displayBuckets(range)) buckets.set(t.getTime(), []);
	for (const sample of samples) {
		const key = displayBucket(sample.at, range.granularity).getTime();
		const list = buckets.get(key);
		if (list) {
			list.push({ agentsOnline: sample.agentsOnline, agentsTotal: sample.agentsTotal });
		} else {
			buckets.set(key, [{ agentsOnline: sample.agentsOnline, agentsTotal: sample.agentsTotal }]);
		}
	}
	const availability = [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([key, list]) => ({
			t: new Date(key).toISOString(),
			agentsOnline: list.length ? Math.round(list.reduce((sum, s) => sum + s.agentsOnline, 0) / list.length) : 0,
			agentsTotal: list.length ? Math.round(list.reduce((sum, s) => sum + s.agentsTotal, 0) / list.length) : 0,
		}));

	return {
		cards: {
			jobs: { value: totalJobs, spark: jobsSpark },
			successRate: { value: successRateValue, spark: successRateSpark },
			printP50Ms: { value: printP50Value, spark: printP50Spark },
			agentsOnline: { online: agentsOnline, total: agents.length },
			printersConnected: { connected: printersConnected, total: devices.length },
			queueDepth,
		},
		jobsOverTime,
		availability,
		failuresOverTime,
	};
}
