"use client";

import { ChartColumn } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

/** Monday-first, matching the `(getUTCDay() + 6) % 7` bucketing `jobsTabData` builds `heatmap` with. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const LEGEND_STEPS = [10, 30, 50, 70, 100];

/**
 * A 7×24 job-volume heatmap: weekday rows, hour-of-day columns, cell shade scaled 0–100% between
 * `var(--chart-1)` and transparent by `count / max`.
 *
 * `data[weekday][hour]` — 7 rows (Mon..Sun), 24 columns (0..23) — matching `JobsTabData.heatmap`.
 */
export function Heatmap(props: { data: number[][] }) {
	const { data } = props;
	const max = Math.max(0, ...data.flat());

	if (max === 0) {
		return (
			<Empty className="min-h-[160px] gap-2 p-0">
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

	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2">
				<div className="flex w-8 shrink-0 flex-col gap-[3px] pt-px text-[10px] text-subtle-foreground">
					{WEEKDAYS.map((day) => (
						<span key={day} className="flex h-4 items-center leading-none">
							{day}
						</span>
					))}
				</div>
				<div className="flex flex-1 flex-col gap-[3px]">
					{data.map((row, weekday) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are a fixed 7-weekday tuple, never reordered.
						<div key={weekday} className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]">
							{row.map((count, hour) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: a fixed 7×24 weekday/hour grid, never reordered.
									key={`${weekday}-${hour}`}
									title={`${WEEKDAYS[weekday]} ${hour}:00 — ${count.toLocaleString()} job${count === 1 ? "" : "s"}`}
									className="h-4 rounded-[2px] ring-1 ring-inset ring-border/50"
									style={{
										backgroundColor:
											count === 0
												? "transparent"
												: `color-mix(in oklch, var(--chart-1) ${Math.max(Math.round((count / max) * 100), 8)}%, transparent)`,
									}}
								/>
							))}
						</div>
					))}
				</div>
			</div>
			<div className="ml-10 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]">
				{Array.from({ length: 24 }, (_, hour) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixed 0..23 hour axis, never reordered.
					<span key={hour} className="text-center text-[9px] text-subtle-foreground">
						{hour % 3 === 0 ? hour : ""}
					</span>
				))}
			</div>
			<div className="flex items-center justify-end gap-1.5 text-[10px] text-subtle-foreground">
				<span>less</span>
				<div className="flex gap-[2px]">
					{LEGEND_STEPS.map((pct) => (
						<div
							key={pct}
							className="h-3 w-3 rounded-[2px]"
							style={{ backgroundColor: `color-mix(in oklch, var(--chart-1) ${pct}%, transparent)` }}
						/>
					))}
				</div>
				<span>more</span>
			</div>
		</div>
	);
}
