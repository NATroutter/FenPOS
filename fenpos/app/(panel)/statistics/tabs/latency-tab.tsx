import { CategoryBarChart, ChartCard, HistogramChart, TimeSeriesChart } from "@/app/(panel)/statistics/charts";
import { StatCard } from "@/app/(panel)/statistics/stat-card";
import type { StatisticsFilter } from "@/app/(panel)/statistics/tab-content";
import { latencyTabData } from "@/lib/metrics/query/latency";
import type { ResolvedRange } from "@/lib/metrics/range";

const PERCENTILE_SERIES = [
	{ key: "p50", label: "p50" },
	{ key: "p95", label: "p95" },
	{ key: "p99", label: "p99" },
];

/** The Latency tab: percentile trends for queue/print/total duration, the fleet-wide distribution. */
export async function LatencyTab({ range, filter }: { range: ResolvedRange; filter: StatisticsFilter }) {
	const data = await latencyTabData(range, filter);

	return (
		<div className="flex flex-col gap-4">
			<StatCard label="Clock skew events" value={data.clockSkewCount.toLocaleString()} className="sm:max-w-xs" />

			<div className="grid gap-4 lg:grid-cols-2">
				<ChartCard title="Print time percentiles">
					<TimeSeriesChart kind="line" data={data.printPercentiles} series={PERCENTILE_SERIES} valueFormat="ms" />
				</ChartCard>

				<ChartCard title="Queue time percentiles">
					<TimeSeriesChart kind="line" data={data.queuePercentiles} series={PERCENTILE_SERIES} valueFormat="ms" />
				</ChartCard>

				<ChartCard title="Total time percentiles">
					<TimeSeriesChart kind="line" data={data.totalPercentiles} series={PERCENTILE_SERIES} valueFormat="ms" />
				</ChartCard>

				<ChartCard title="Print time distribution">
					<HistogramChart data={data.distribution} />
				</ChartCard>

				<div className="lg:col-span-2">
					<ChartCard title="Slowest printers" description="By p95 print time">
						<CategoryBarChart
							data={data.slowestPrinters.map((row) => ({ name: row.name, p95Ms: row.p95Ms }))}
							series={[{ key: "p95Ms", label: "p95" }]}
							valueFormat="ms"
						/>
					</ChartCard>
				</div>
			</div>
		</div>
	);
}
