"use client";

import { Line, LineChart, ResponsiveContainer } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/** A tiny, axis-free trend line — a stat card's own sparkline, or a table's sparkline cell. */
export function Sparkline(props: { data: { t: string; v: number | null }[]; height?: number; className?: string }) {
	const { data, height = 40, className } = props;
	return (
		<div className={className} style={{ height, width: "100%" }}>
			<ResponsiveContainer width="100%" height="100%">
				<LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
					<Line
						type="monotone"
						dataKey="v"
						stroke="var(--chart-1)"
						strokeWidth={1.5}
						dot={false}
						connectNulls={false}
						isAnimationActive={false}
					/>
				</LineChart>
			</ResponsiveContainer>
		</div>
	);
}

/**
 * One headline number on the Overview tab: a label, a pre-formatted value, an optional 40px-high
 * sparkline with no axes, and an optional "Live" badge for a card that reads the current registry
 * state rather than a rollup.
 *
 * `value` is already formatted by the caller (a ratio like "3 / 5", a percent, a duration) — this
 * component only lays it out, matching how `TimeSeriesChart`'s `valueFormat` stays a chart concern
 * rather than a stat-card one.
 */
export function StatCard(props: {
	label: string;
	value: string;
	spark?: { t: string; v: number | null }[];
	live?: boolean;
	className?: string;
}) {
	const { label, value, spark, live, className } = props;
	const hasSpark = spark !== undefined && spark.length > 0 && spark.some((point) => point.v !== null);

	return (
		<Card size="sm" className={className}>
			<CardContent className="flex flex-col gap-1">
				<div className="flex items-center justify-between gap-2">
					<span className="text-[11px] text-subtle-foreground">{label}</span>
					{live ? (
						<Badge variant="outline" className="gap-1.5 text-[10px]">
							<span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
							Live
						</Badge>
					) : null}
				</div>
				<span className="font-heading text-2xl font-medium tracking-tight">{value}</span>
				{hasSpark ? <Sparkline data={spark} /> : null}
			</CardContent>
		</Card>
	);
}
