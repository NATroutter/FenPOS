import { ChartCard, TimeSeriesChart } from "@/app/(panel)/statistics/charts";
import { formatValue } from "@/app/(panel)/statistics/format";
import { StatCard } from "@/app/(panel)/statistics/stat-card";
import type { StatisticsFilter } from "@/app/(panel)/statistics/tab-content";
import { overviewTabData } from "@/lib/metrics/query/overview";
import type { ResolvedRange } from "@/lib/metrics/range";

/**
 * The Overview tab: six headline stat cards, then the four charts they summarize.
 *
 * Three cards read the current registry/queue state (`agentsOnline`, `printersConnected`,
 * `queueDepth` — see `overviewTabData`'s module comment) and carry a "Live" badge with no
 * sparkline; the other three are range-scoped totals with a trend line.
 */
export async function OverviewTab({ range, filter }: { range: ResolvedRange; filter: StatisticsFilter }) {
	const data = await overviewTabData(range, filter);
	const { cards } = data;

	// Derived here rather than fetched: `jobsOverTime` already carries both counts, and a fourth
	// query for a ratio of two numbers the tab holds would be a round trip for arithmetic. Null on
	// an empty bucket so a quiet hour reads as a gap, not a cliff to 0%.
	const successRate = data.jobsOverTime.map((point) => {
		const settled = point.completed + point.failed;
		return { t: point.t, rate: settled > 0 ? point.completed / settled : null };
	});

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				<StatCard label="Jobs" value={formatValue(cards.jobs.value)} spark={cards.jobs.spark} />
				<StatCard
					label="Success rate"
					value={formatValue(cards.successRate.value, "percent")}
					spark={cards.successRate.spark}
				/>
				<StatCard
					label="Print time (p50)"
					value={formatValue(cards.printP50Ms.value, "ms")}
					spark={cards.printP50Ms.spark}
				/>
				<StatCard label="Agents online" value={`${cards.agentsOnline.online} / ${cards.agentsOnline.total}`} live />
				<StatCard
					label="Printers connected"
					value={`${cards.printersConnected.connected} / ${cards.printersConnected.total}`}
					live
				/>
				<StatCard label="Queue depth" value={formatValue(cards.queueDepth)} live />
			</div>

			<div className="grid gap-4 lg:grid-cols-2">
				<ChartCard title="Jobs over time" description="Completed, failed, and cancelled">
					<TimeSeriesChart
						kind="area"
						stacked
						data={data.jobsOverTime}
						series={[
							{ key: "completed", label: "Completed" },
							{ key: "failed", label: "Failed" },
							{ key: "cancelled", label: "Cancelled" },
						]}
					/>
				</ChartCard>

				<ChartCard title="Fleet availability" description="Agents online vs. total">
					<TimeSeriesChart
						kind="line"
						data={data.availability}
						series={[
							{ key: "agentsOnline", label: "Online" },
							{ key: "agentsTotal", label: "Total" },
						]}
					/>
				</ChartCard>

				<ChartCard title="Failures over time">
					<TimeSeriesChart kind="bar" data={data.failuresOverTime} series={[{ key: "failed", label: "Failed" }]} />
				</ChartCard>

				<ChartCard title="Success rate" description="Completed as a share of settled jobs">
					<TimeSeriesChart
						kind="line"
						data={successRate}
						series={[{ key: "rate", label: "Success rate" }]}
						valueFormat="percent"
						referenceY={1}
					/>
				</ChartCard>
			</div>
		</div>
	);
}
