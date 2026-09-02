"use client";

import { ChartColumn } from "lucide-react";
import type * as React from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Line,
	LineChart,
	Pie,
	PieChart,
	XAxis,
	YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { describeBytes } from "@/lib/format/bytes";

/**
 * The chart primitives every statistics tab is built from.
 *
 * Kept to exactly five: a time series (area/bar/line, optionally stacked or stepped), a horizontal
 * category-bar chart for top-N breakdowns, a donut, a labelled-bucket histogram, and the card that
 * wraps any of them. A tab server component fetches its `*TabData` shape and lays these out — it
 * never reaches for `recharts` directly.
 */

export interface SeriesSpec {
	key: string;
	label: string;
}

export type ValueFormat = "count" | "ms" | "percent" | "bytes";

/** One value, formatted the way its chart's `valueFormat` says to state it. */
export function formatValue(value: number | string | null | undefined, format?: ValueFormat): string {
	if (value === null || value === undefined) return "–";
	const n = typeof value === "number" ? value : Number(value);
	if (Number.isNaN(n)) return String(value);
	switch (format) {
		case "ms":
			return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
		case "percent":
			return `${Math.round(n * 100)}%`;
		case "bytes":
			return describeBytes(n);
		default:
			return n.toLocaleString();
	}
}

/** Builds a `ChartConfig` from a series list: label plus a color cycling `var(--chart-1..5)`. */
function buildConfig(series: SeriesSpec[]): ChartConfig {
	const config: ChartConfig = {};
	series.forEach((s, i) => {
		config[s.key] = { label: s.label, color: `var(--chart-${(i % 5) + 1})` };
	});
	return config;
}

/** Every numeric value across every row and series is 0 or null — nothing worth charting. */
function isEmptySeries(rows: Record<string, unknown>[], keys: string[]): boolean {
	if (rows.length === 0) return true;
	return rows.every((row) => keys.every((key) => row[key] === null || row[key] === undefined || row[key] === 0));
}

function EmptyChartState() {
	return (
		<Empty className="min-h-[200px] gap-2 p-0">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ChartColumn />
				</EmptyMedia>
				<EmptyTitle>No data in this range</EmptyTitle>
				<EmptyDescription>Try a wider range or a different filter.</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

const HOUR_TICK = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
	hour12: false,
	timeZone: "UTC",
});
const DATE_TICK = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const FULL_TICK = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	hour12: false,
	timeZone: "UTC",
});

const HOUR_SPACING_MS = 90 * 60 * 1000; // 1.5h — comfortably above an exact 1h bucket, below a day.

/** Spacing between the first two rows' `t` values, in ms, or 0 when there is nothing to infer from. */
function inferSpacingMs(data: { t: string | number | null }[]): number {
	if (data.length < 2) return 0;
	const a = new Date(String(data[0].t)).getTime();
	const b = new Date(String(data[1].t)).getTime();
	return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(b - a) : 0;
}

/** Shortens an ISO `t` value for an axis tick: hour granularity → "14:00", day/week → "Aug 12". */
function tickFormatterFor(spacingMs: number): (value: string) => string {
	const fmt = spacingMs > 0 && spacingMs <= HOUR_SPACING_MS ? HOUR_TICK : DATE_TICK;
	return (value: string) => fmt.format(new Date(value));
}

/** Mirrors `ChartTooltipContent`'s default row layout, but with a pre-formatted value and label. */
function TooltipRow(props: { label: React.ReactNode; value: string; color?: string }) {
	const { label, value, color } = props;
	return (
		<div className="flex w-full flex-1 items-center justify-between gap-2 leading-none">
			<div className="flex items-center gap-1.5">
				<div className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
				<span className="text-muted-foreground">{label}</span>
			</div>
			<span className="font-mono font-medium text-foreground tabular-nums">{value}</span>
		</div>
	);
}

function truncate(label: string, max: number): string {
	return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/**
 * Time series: `kind` picks the mark; `stacked` applies to area and bar; `stepped` draws a step
 * curve on area/line. Renders an explicit empty state when every series value in every row is 0 or
 * null. Colors cycle `var(--chart-1..5)`.
 */
export function TimeSeriesChart(props: {
	kind: "area" | "bar" | "line";
	data: Record<string, string | number | null>[];
	series: SeriesSpec[];
	stacked?: boolean;
	stepped?: boolean;
	valueFormat?: ValueFormat;
	className?: string;
}) {
	const { kind, data, series, stacked, stepped, valueFormat, className } = props;
	const keys = series.map((s) => s.key);

	if (isEmptySeries(data, keys)) {
		return <EmptyChartState />;
	}

	const config = buildConfig(series);
	const spacingMs = inferSpacingMs(data as { t: string | number | null }[]);
	const axisTick = tickFormatterFor(spacingMs);
	const valueTick = (v: number) => formatValue(v, valueFormat);
	const curveType = stepped ? "step" : "monotone";
	const stackId = stacked ? "stack" : undefined;
	const yDomain: [number, number] | undefined = valueFormat === "percent" ? [0, 1] : undefined;

	return (
		<ChartContainer config={config} className={className ?? "aspect-auto h-[260px] w-full"}>
			{kind === "area" ? (
				<AreaChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
					<CartesianGrid vertical={false} />
					<XAxis
						dataKey="t"
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						minTickGap={24}
						tickFormatter={axisTick}
						fontSize={11}
					/>
					<YAxis
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						width={44}
						fontSize={11}
						tickFormatter={valueTick}
						domain={yDomain}
					/>
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(l) => FULL_TICK.format(new Date(String(l)))}
								formatter={(value, name, item) => (
									<TooltipRow
										label={config[String(name)]?.label ?? name}
										value={formatValue(typeof value === "number" ? value : Number(value), valueFormat)}
										color={(item.payload as { fill?: string } | undefined)?.fill ?? item.color}
									/>
								)}
							/>
						}
					/>
					{series.map((s) => (
						<Area
							key={s.key}
							dataKey={s.key}
							type={curveType}
							stackId={stackId}
							stroke={`var(--color-${s.key})`}
							fill={`var(--color-${s.key})`}
							fillOpacity={0.3}
							connectNulls={false}
							isAnimationActive={false}
						/>
					))}
					{series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
				</AreaChart>
			) : kind === "bar" ? (
				<BarChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
					<CartesianGrid vertical={false} />
					<XAxis
						dataKey="t"
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						minTickGap={24}
						tickFormatter={axisTick}
						fontSize={11}
					/>
					<YAxis
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						width={44}
						fontSize={11}
						tickFormatter={valueTick}
						domain={yDomain}
					/>
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(l) => FULL_TICK.format(new Date(String(l)))}
								formatter={(value, name, item) => (
									<TooltipRow
										label={config[String(name)]?.label ?? name}
										value={formatValue(typeof value === "number" ? value : Number(value), valueFormat)}
										color={(item.payload as { fill?: string } | undefined)?.fill ?? item.color}
									/>
								)}
							/>
						}
					/>
					{series.map((s) => (
						<Bar
							key={s.key}
							dataKey={s.key}
							stackId={stackId}
							fill={`var(--color-${s.key})`}
							radius={stacked ? undefined : 4}
							isAnimationActive={false}
						/>
					))}
					{series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
				</BarChart>
			) : (
				<LineChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
					<CartesianGrid vertical={false} />
					<XAxis
						dataKey="t"
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						minTickGap={24}
						tickFormatter={axisTick}
						fontSize={11}
					/>
					<YAxis
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						width={44}
						fontSize={11}
						tickFormatter={valueTick}
						domain={yDomain}
					/>
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(l) => FULL_TICK.format(new Date(String(l)))}
								formatter={(value, name, item) => (
									<TooltipRow
										label={config[String(name)]?.label ?? name}
										value={formatValue(typeof value === "number" ? value : Number(value), valueFormat)}
										color={(item.payload as { fill?: string } | undefined)?.fill ?? item.color}
									/>
								)}
							/>
						}
					/>
					{series.map((s) => (
						<Line
							key={s.key}
							dataKey={s.key}
							type={curveType}
							stroke={`var(--color-${s.key})`}
							strokeWidth={2}
							dot={false}
							connectNulls={false}
							isAnimationActive={false}
						/>
					))}
					{series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
				</LineChart>
			)}
		</ChartContainer>
	);
}

/** Horizontal category bars (top-N charts). Shows at most the first 12 rows — callers pre-sort. */
export function CategoryBarChart(props: {
	data: { name: string; [k: string]: string | number | null }[];
	series: SeriesSpec[];
	valueFormat?: "count" | "ms" | "bytes";
}) {
	const { series, valueFormat } = props;
	const keys = series.map((s) => s.key);
	const data = props.data.slice(0, 12);

	if (isEmptySeries(data, keys)) {
		return <EmptyChartState />;
	}

	const config = buildConfig(series);
	const rowHeight = 28;
	const height = Math.max(160, data.length * rowHeight + 40);

	return (
		<ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
			<BarChart data={data} layout="vertical" margin={{ left: 4, right: 8, top: 4 }}>
				<CartesianGrid horizontal={false} />
				<XAxis
					type="number"
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					fontSize={11}
					tickFormatter={(v) => formatValue(v, valueFormat)}
				/>
				<YAxis
					type="category"
					dataKey="name"
					tickLine={false}
					axisLine={false}
					width={110}
					fontSize={11}
					tickFormatter={(v) => truncate(String(v), 16)}
				/>
				<ChartTooltip
					content={
						<ChartTooltipContent
							formatter={(value, name, item) => (
								<TooltipRow
									label={config[String(name)]?.label ?? name}
									value={formatValue(typeof value === "number" ? value : Number(value), valueFormat)}
									color={(item.payload as { fill?: string } | undefined)?.fill ?? item.color}
								/>
							)}
						/>
					}
				/>
				{series.map((s) => (
					<Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={4} isAnimationActive={false} />
				))}
				{series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
			</BarChart>
		</ChartContainer>
	);
}

/** Donut. */
export function DonutChart(props: { data: { name: string; value: number }[] }) {
	const { data } = props;
	const empty = data.length === 0 || data.every((d) => !d.value);
	if (empty) {
		return <EmptyChartState />;
	}

	const config: ChartConfig = {};
	data.forEach((d, i) => {
		config[d.name] = { label: d.name, color: `var(--chart-${(i % 5) + 1})` };
	});

	return (
		<ChartContainer config={config} className="mx-auto aspect-auto h-[240px] w-full">
			<PieChart>
				<ChartTooltip
					content={
						<ChartTooltipContent
							hideLabel
							nameKey="name"
							formatter={(value, name, item) => (
								<TooltipRow
									label={name}
									value={formatValue(typeof value === "number" ? value : Number(value))}
									color={(item.payload as { fill?: string } | undefined)?.fill ?? item.color}
								/>
							)}
						/>
					}
				/>
				<Pie
					data={data}
					dataKey="value"
					nameKey="name"
					innerRadius={55}
					outerRadius={85}
					strokeWidth={2}
					isAnimationActive={false}
				>
					{data.map((d, i) => (
						<Cell key={d.name} fill={`var(--chart-${(i % 5) + 1})`} />
					))}
				</Pie>
				<ChartLegend content={<ChartLegendContent nameKey="name" />} />
			</PieChart>
		</ChartContainer>
	);
}

/** Distribution bars over labelled buckets. */
export function HistogramChart(props: { data: { bucket: string; count: number }[] }) {
	const { data } = props;
	const empty = data.length === 0 || data.every((d) => !d.count);
	if (empty) {
		return <EmptyChartState />;
	}

	const config: ChartConfig = { count: { label: "Count", color: "var(--chart-1)" } };

	return (
		<ChartContainer config={config} className="aspect-auto h-[240px] w-full">
			<BarChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
				<YAxis
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					width={40}
					fontSize={11}
					tickFormatter={(v) => formatValue(v)}
				/>
				<ChartTooltip
					content={
						<ChartTooltipContent
							formatter={(value, name, item) => (
								<TooltipRow
									label={config[String(name)]?.label ?? name}
									value={formatValue(typeof value === "number" ? value : Number(value), "count")}
									color={(item.payload as { fill?: string } | undefined)?.fill ?? item.color}
								/>
							)}
						/>
					}
				/>
				<Bar dataKey="count" fill="var(--color-count)" radius={4} isAnimationActive={false} />
			</BarChart>
		</ChartContainer>
	);
}

/** Card wrapper: title, one-line description, children. A chart primitive renders its own empty
 * state inline, so this is a plain frame — the empty state simply ends up in the content area. */
export function ChartCard(props: { title: string; description?: string; children: React.ReactNode }) {
	const { title, description, children } = props;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				{description ? <CardDescription>{description}</CardDescription> : null}
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}
