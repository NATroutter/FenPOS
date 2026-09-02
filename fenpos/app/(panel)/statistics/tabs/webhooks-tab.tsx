import { CategoryBarChart, ChartCard, HistogramChart, TimeSeriesChart } from "@/app/(panel)/statistics/charts";
import type { StatisticsFilter } from "@/app/(panel)/statistics/tab-content";
import { webhooksTabData } from "@/lib/metrics/query/webhooks";
import type { ResolvedRange } from "@/lib/metrics/range";

/** The Webhooks tab: delivery throughput, attempt counts, and the per-webhook breakdown. */
export async function WebhooksTab({ range, filter }: { range: ResolvedRange; filter: StatisticsFilter }) {
	const data = await webhooksTabData(range, filter);

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<ChartCard title="Deliveries" description="Delivered, failed, and queued">
				<TimeSeriesChart
					kind="bar"
					stacked
					data={data.deliveries}
					series={[
						{ key: "delivered", label: "Delivered" },
						{ key: "failed", label: "Failed" },
						{ key: "queued", label: "Queued" },
					]}
				/>
			</ChartCard>

			<ChartCard title="Success rate">
				<TimeSeriesChart
					kind="line"
					data={data.successRate}
					series={[{ key: "rate", label: "Success rate" }]}
					valueFormat="percent"
				/>
			</ChartCard>

			<ChartCard title="Attempts per delivery">
				<HistogramChart data={data.attempts} />
			</ChartCard>

			<ChartCard title="Backlog" description="Pending deliveries, sampled">
				<TimeSeriesChart kind="line" data={data.backlog} series={[{ key: "pending", label: "Pending" }]} />
			</ChartCard>

			<div className="lg:col-span-2">
				<ChartCard title="Per webhook" description="Delivered vs. failed">
					<CategoryBarChart
						data={data.perWebhook}
						series={[
							{ key: "delivered", label: "Delivered" },
							{ key: "failed", label: "Failed" },
						]}
					/>
				</ChartCard>
			</div>
		</div>
	);
}
