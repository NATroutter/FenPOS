import { CategoryBarChart, ChartCard, DonutChart, TimeSeriesChart } from "@/app/(panel)/statistics/charts";
import type { StatisticsFilter } from "@/app/(panel)/statistics/tab-content";
import { fleetTabData } from "@/lib/metrics/query/fleet";
import type { ResolvedRange } from "@/lib/metrics/range";

/**
 * The Fleet tab: agent/device availability, queue depth, and the fleet's current shape.
 *
 * No per-agent availability chart — `fleetTabData`'s module comment explains why: fleet samples are
 * fleet-wide totals, so there is no per-agent history to draw one from.
 */
export async function FleetTab({ range, filter }: { range: ResolvedRange; filter: StatisticsFilter }) {
	const data = await fleetTabData(range, filter);

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<ChartCard title="Agents online" description="Online vs. total, sampled">
				<TimeSeriesChart
					kind="area"
					stepped
					data={data.agentsOnline}
					series={[
						{ key: "online", label: "Online" },
						{ key: "total", label: "Total" },
					]}
				/>
			</ChartCard>

			<ChartCard title="Printers connected" description="Connected vs. total, sampled">
				<TimeSeriesChart
					kind="area"
					stepped
					data={data.devicesConnected}
					series={[
						{ key: "connected", label: "Connected" },
						{ key: "total", label: "Total" },
					]}
				/>
			</ChartCard>

			<ChartCard title="Queue depth">
				<TimeSeriesChart kind="line" data={data.queueDepth} series={[{ key: "depth", label: "Queue depth" }]} />
			</ChartCard>

			<ChartCard title="Platforms">
				<CategoryBarChart
					data={data.platforms.map((row) => ({ name: row.platform, count: row.count }))}
					series={[{ key: "count", label: "Agents" }]}
				/>
			</ChartCard>

			<ChartCard title="Status now">
				<DonutChart data={data.statusNow.map((row) => ({ name: row.status, value: row.count }))} />
			</ChartCard>

			<ChartCard title="Agent versions">
				<DonutChart data={data.versions.map((row) => ({ name: row.version, value: row.count }))} />
			</ChartCard>
		</div>
	);
}
