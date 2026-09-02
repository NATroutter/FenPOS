import { CategoryBarChart, ChartCard, TimeSeriesChart } from "@/app/(panel)/statistics/charts";
import type { StatisticsFilter } from "@/app/(panel)/statistics/tab-content";
import { apiTabData } from "@/lib/metrics/query/api";
import type { ResolvedRange } from "@/lib/metrics/range";

/** The API tab: v1 request volume, endpoint/key breakdowns, rejections, and response latency. */
export async function ApiTab({ range, filter }: { range: ResolvedRange; filter: StatisticsFilter }) {
	const data = await apiTabData(range, filter);

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<ChartCard title="Requests" description="2xx, 4xx, and 5xx">
				<TimeSeriesChart
					kind="area"
					stacked
					data={data.requests}
					series={[
						{ key: "ok", label: "OK" },
						{ key: "clientError", label: "Client error" },
						{ key: "serverError", label: "Server error" },
					]}
				/>
			</ChartCard>

			<ChartCard title="Rejections" description="Auth, rate limit, and validation">
				<TimeSeriesChart
					kind="bar"
					stacked
					data={data.rejections}
					series={[
						{ key: "auth", label: "Auth" },
						{ key: "rateLimit", label: "Rate limit" },
						{ key: "validation", label: "Validation" },
					]}
				/>
			</ChartCard>

			<ChartCard title="Response time percentiles">
				<TimeSeriesChart
					kind="line"
					data={data.responsePercentiles}
					series={[
						{ key: "p50", label: "p50" },
						{ key: "p95", label: "p95" },
					]}
					valueFormat="ms"
				/>
			</ChartCard>

			<ChartCard title="By endpoint">
				<CategoryBarChart
					data={data.byEndpoint.map((row) => ({ name: row.route, count: row.count }))}
					series={[{ key: "count", label: "Requests" }]}
				/>
			</ChartCard>

			<div className="lg:col-span-2">
				<ChartCard title="By API key">
					<CategoryBarChart data={data.byKey} series={[{ key: "count", label: "Requests" }]} />
				</ChartCard>
			</div>
		</div>
	);
}
