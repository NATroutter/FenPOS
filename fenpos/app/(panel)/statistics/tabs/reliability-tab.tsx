import { CategoryBarChart, ChartCard, TimeSeriesChart } from "@/app/(panel)/statistics/charts";
import type { SeriesSpec } from "@/app/(panel)/statistics/format";
import { Sparkline } from "@/app/(panel)/statistics/stat-card";
import type { StatisticsFilter } from "@/app/(panel)/statistics/tab-content";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/format/datetime";
import { reliabilityTabData } from "@/lib/metrics/query/reliability";
import type { ResolvedRange } from "@/lib/metrics/range";

/** The Reliability tab: success/cancellation trends, the error-code mix, and the full error table. */
export async function ReliabilityTab({ range, filter }: { range: ResolvedRange; filter: StatisticsFilter }) {
	const data = await reliabilityTabData(range, filter);

	// `errorMix` rows carry the top-5 codes plus "other" as dynamic keys — the series list is read
	// back off the first row rather than duplicated from `reliabilityTabData`'s own `TOP_ERROR_MIX_CODES`.
	const errorMixKeys = data.errorMix.length > 0 ? Object.keys(data.errorMix[0]).filter((key) => key !== "t") : [];
	const errorMixSeries: SeriesSpec[] = errorMixKeys.map((code) => ({
		key: code,
		label: code === "other" ? "Other" : code,
	}));

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-4 lg:grid-cols-2">
				<ChartCard title="Success rate">
					<TimeSeriesChart
						kind="line"
						data={data.successRate}
						series={[{ key: "rate", label: "Success rate" }]}
						valueFormat="percent"
					/>
				</ChartCard>

				<ChartCard title="Cancellation rate">
					<TimeSeriesChart
						kind="line"
						data={data.cancellationRate}
						series={[{ key: "rate", label: "Cancellation rate" }]}
						valueFormat="percent"
					/>
				</ChartCard>

				<ChartCard title="Errors by code">
					<CategoryBarChart
						data={data.byErrorCode.map((row) => ({ name: row.code, count: row.count }))}
						series={[{ key: "count", label: "Count" }]}
					/>
				</ChartCard>

				<ChartCard title="Failures by printer">
					<CategoryBarChart
						data={data.failuresByPrinter.map((row) => ({ name: row.name, failed: row.failed }))}
						series={[{ key: "failed", label: "Failed" }]}
					/>
				</ChartCard>

				<div className="lg:col-span-2">
					<ChartCard title="Error mix over time" description="Top 5 codes, plus everything else">
						<TimeSeriesChart kind="area" stacked data={data.errorMix} series={errorMixSeries} />
					</ChartCard>
				</div>
			</div>

			<div className="rounded-xl border border-border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Code</TableHead>
							<TableHead>Count</TableHead>
							<TableHead>Last seen</TableHead>
							<TableHead>Trend</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.errorTable.length === 0 ? (
							<TableRow>
								<TableCell colSpan={4} className="text-center text-subtle-foreground">
									No errors in this range.
								</TableCell>
							</TableRow>
						) : (
							data.errorTable.map((row) => (
								<TableRow key={row.code}>
									<TableCell className="font-mono">{row.code}</TableCell>
									<TableCell>{row.count.toLocaleString()}</TableCell>
									<TableCell>{row.lastSeen ? formatDate(row.lastSeen) : "–"}</TableCell>
									<TableCell className="w-32">
										<Sparkline data={row.spark} height={28} />
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
