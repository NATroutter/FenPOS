import { CategoryBarChart, ChartCard, TimeSeriesChart } from "@/app/(panel)/statistics/charts";
import type { SeriesSpec } from "@/app/(panel)/statistics/format";
import type { StatisticsFilter } from "@/app/(panel)/statistics/tab-content";
import { securityTabData } from "@/lib/metrics/query/security";
import type { ResolvedRange } from "@/lib/metrics/range";

/** The Security tab: sign-ins, denials, the audit category mix, and storage growth. */
export async function SecurityTab({ range, filter }: { range: ResolvedRange; filter: StatisticsFilter }) {
	const data = await securityTabData(range, filter);

	// `auditCategories` rows carry the top-6 categories plus "other" as dynamic keys — read back off
	// the first row rather than duplicated from `securityTabData`'s own `TOP_CATEGORIES`.
	const categoryKeys =
		data.auditCategories.length > 0 ? Object.keys(data.auditCategories[0]).filter((key) => key !== "t") : [];
	const categorySeries: SeriesSpec[] = categoryKeys.map((category) => ({
		key: category,
		label: category === "other" ? "Other" : category,
	}));

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<ChartCard title="Sign-ins" description="Success vs. failed">
				<TimeSeriesChart
					kind="bar"
					stacked
					data={data.signIns}
					series={[
						{ key: "success", label: "Success" },
						{ key: "failed", label: "Failed" },
					]}
				/>
			</ChartCard>

			<ChartCard title="Denied actions">
				<TimeSeriesChart kind="line" data={data.deniedActions} series={[{ key: "denied", label: "Denied" }]} />
			</ChartCard>

			<ChartCard title="Failed sign-ins by IP">
				<CategoryBarChart
					data={data.failedByIp.map((row) => ({ name: row.ip, count: row.count }))}
					series={[{ key: "count", label: "Failed" }]}
				/>
			</ChartCard>

			<ChartCard title="Active sessions" description="Sampled">
				<TimeSeriesChart kind="line" data={data.activeSessions} series={[{ key: "sessions", label: "Sessions" }]} />
			</ChartCard>

			<div className="lg:col-span-2">
				<ChartCard title="Audit activity" description="Top 6 categories, plus everything else">
					<TimeSeriesChart kind="area" stacked data={data.auditCategories} series={categorySeries} />
				</ChartCard>
			</div>

			<div className="lg:col-span-2">
				<ChartCard title="Database storage" description="Sampled, in MB">
					<TimeSeriesChart
						kind="line"
						data={data.storage}
						series={[
							{ key: "mainMB", label: "Main" },
							{ key: "auditMB", label: "Audit" },
							{ key: "logsMB", label: "Logs" },
						]}
					/>
				</ChartCard>
			</div>
		</div>
	);
}
