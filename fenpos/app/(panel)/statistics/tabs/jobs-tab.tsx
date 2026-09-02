import { CategoryBarChart, ChartCard, HistogramChart, TimeSeriesChart } from "@/app/(panel)/statistics/charts";
import { Heatmap } from "@/app/(panel)/statistics/heatmap";
import type { StatisticsFilter } from "@/app/(panel)/statistics/tab-content";
import { jobsTabData } from "@/lib/metrics/query/jobs";
import type { ResolvedRange } from "@/lib/metrics/range";

/** The Jobs tab: throughput, source mix, size and timing breakdowns. */
export async function JobsTab({ range, filter }: { range: ResolvedRange; filter: StatisticsFilter }) {
	const data = await jobsTabData(range, filter);

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<ChartCard title="Jobs over time" description="Completed, failed, and cancelled">
				<TimeSeriesChart
					kind="bar"
					stacked
					data={data.jobsOverTime}
					series={[
						{ key: "completed", label: "Completed" },
						{ key: "failed", label: "Failed" },
						{ key: "cancelled", label: "Cancelled" },
					]}
				/>
			</ChartCard>

			<ChartCard title="Source" description="Panel vs. API">
				<TimeSeriesChart
					kind="area"
					stacked
					data={data.bySource}
					series={[
						{ key: "panel", label: "Panel" },
						{ key: "api", label: "API" },
					]}
				/>
			</ChartCard>

			<ChartCard title="Bytes printed">
				<TimeSeriesChart
					kind="area"
					data={data.bytesOverTime}
					series={[{ key: "bytes", label: "Bytes" }]}
					valueFormat="bytes"
				/>
			</ChartCard>

			<ChartCard title="Lines printed">
				<TimeSeriesChart kind="area" data={data.linesOverTime} series={[{ key: "lines", label: "Lines" }]} />
			</ChartCard>

			<ChartCard title="Job size distribution">
				<HistogramChart data={data.sizeDistribution} />
			</ChartCard>

			<ChartCard title="Average job size">
				<TimeSeriesChart
					kind="line"
					data={data.averageSize}
					series={[{ key: "avgBytes", label: "Average size" }]}
					valueFormat="bytes"
				/>
			</ChartCard>

			<ChartCard title="Top printers" description="By job count">
				<CategoryBarChart data={data.topPrinters} series={[{ key: "jobs", label: "Jobs" }]} />
			</ChartCard>

			<ChartCard title="Top agents" description="By job count">
				<CategoryBarChart data={data.topAgents} series={[{ key: "jobs", label: "Jobs" }]} />
			</ChartCard>

			<div className="lg:col-span-2">
				<ChartCard title="Top API keys" description="By job count">
					<CategoryBarChart data={data.topKeys} series={[{ key: "jobs", label: "Jobs" }]} />
				</ChartCard>
			</div>

			<div className="lg:col-span-2">
				<ChartCard title="When jobs run" description="Jobs by weekday and hour, UTC">
					<Heatmap data={data.heatmap} />
				</ChartCard>
			</div>
		</div>
	);
}
