import "server-only";
import { metricsDb, prisma } from "@/lib/db";
import { isConnected } from "@/lib/link/registry";
import type { MetricsFilter } from "@/lib/metrics/query/series";
import { displayBucket, displayBuckets, type ResolvedRange } from "@/lib/metrics/range";

/**
 * The Fleet tab: agent/device availability, queue depth, and the fleet's current shape.
 *
 * `agentAvailability` (spec §5 #35) is deliberately absent — see task-11-brief.md's note. Fleet
 * samples are fleet-wide totals; there is no per-agent sample to build a per-agent history from, so
 * rather than fake one from job activity the metric is dropped from this tab entirely.
 *
 * `statusNow` starts from the stored `Agent.status` column but overrides it with the live registry:
 * an agent actually holding a connection counts ONLINE regardless of what the column says, and a
 * column that still says ONLINE for an agent with no live connection — the column is only updated on
 * connect/disconnect, so a crash between those events can leave it stale — is corrected to OFFLINE.
 */

export interface FleetTabData {
	agentsOnline: { t: string; online: number | null; total: number | null }[];
	devicesConnected: { t: string; connected: number | null; total: number | null }[];
	queueDepth: { t: string; depth: number | null }[];
	statusNow: { status: string; count: number }[];
	versions: { version: string; count: number }[];
	platforms: { platform: string; count: number }[];
}

interface SampleRow {
	agentsOnline: number;
	agentsTotal: number;
	devicesConnected: number;
	devicesTotal: number;
	queueDepth: number;
}

function bucketSamples(range: ResolvedRange, samples: (SampleRow & { at: Date })[]): SampleRow[][] {
	const buckets = new Map<number, SampleRow[]>();
	for (const t of displayBuckets(range)) buckets.set(t.getTime(), []);
	for (const sample of samples) {
		const key = displayBucket(sample.at, range.granularity).getTime();
		const list = buckets.get(key);
		if (list) {
			list.push(sample);
		} else {
			buckets.set(key, [sample]);
		}
	}
	return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

function bucketTimes(range: ResolvedRange): Date[] {
	return displayBuckets(range);
}

/** A bucket with no samples yields null — a gap in the chart, not a false zero. */
function average(list: SampleRow[], pick: (s: SampleRow) => number): number | null {
	if (list.length === 0) return null;
	return Math.round(list.reduce((sum, s) => sum + pick(s), 0) / list.length);
}

export async function fleetTabData(range: ResolvedRange, filter: MetricsFilter): Promise<FleetTabData> {
	// A device filter narrows nothing on this tab: every chart here is agent- or fleet-scoped, and
	// there is no per-device breakdown in `FleetTabData` for it to apply to.
	const [samples, agents] = await Promise.all([
		metricsDb.fleetSample.findMany({ where: { at: { gte: range.from, lt: range.to } } }),
		prisma.agent.findMany({
			where: filter.agentId ? { id: filter.agentId } : {},
			select: { id: true, status: true, agentVersion: true, platform: true },
		}),
	]);

	const times = bucketTimes(range);
	const grouped = bucketSamples(range, samples);

	const agentsOnline = times.map((t, i) => ({
		t: t.toISOString(),
		online: average(grouped[i], (s) => s.agentsOnline),
		total: average(grouped[i], (s) => s.agentsTotal),
	}));
	const devicesConnected = times.map((t, i) => ({
		t: t.toISOString(),
		connected: average(grouped[i], (s) => s.devicesConnected),
		total: average(grouped[i], (s) => s.devicesTotal),
	}));
	const queueDepth = times.map((t, i) => ({ t: t.toISOString(), depth: average(grouped[i], (s) => s.queueDepth) }));

	const statusCounts = new Map<string, number>();
	for (const agent of agents) {
		const effectiveStatus = isConnected(agent.id) ? "ONLINE" : agent.status === "ONLINE" ? "OFFLINE" : agent.status;
		statusCounts.set(effectiveStatus, (statusCounts.get(effectiveStatus) ?? 0) + 1);
	}
	const statusNow = [...statusCounts.entries()].map(([status, count]) => ({ status, count }));

	const versionCounts = new Map<string, number>();
	const platformCounts = new Map<string, number>();
	for (const agent of agents) {
		const version = agent.agentVersion ?? "unknown";
		const platform = agent.platform ?? "unknown";
		versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);
		platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1);
	}
	const versions = [...versionCounts.entries()]
		.map(([version, count]) => ({ version, count }))
		.sort((a, b) => b.count - a.count);
	const platforms = [...platformCounts.entries()]
		.map(([platform, count]) => ({ platform, count }))
		.sort((a, b) => b.count - a.count);

	return { agentsOnline, devicesConnected, queueDepth, statusNow, versions, platforms };
}
