"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useFollow } from "@/app/(panel)/logs/follow";
import { useEventStream } from "@/components/panel/event-stream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumns } from "@/components/ui/data-table";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { LogLevel } from "@/lib/domain/enums";
import { formatDateTime } from "@/lib/format/datetime";
import type { LogLine } from "@/lib/logs/log-service";
import { LOG_DEFAULT_SORT } from "@/lib/logs/log-sort";

/** Chip styling per severity. */
const LEVEL_STYLE: Record<LogLevel, string> = {
	DEBUG: "border-border bg-muted text-subtle-foreground",
	INFO: "border-emerald-900 bg-emerald-950 text-emerald-400",
	WARN: "border-amber-900 bg-amber-950 text-amber-400",
	ERROR: "border-destructive/40 bg-destructive/10 text-destructive",
};

/**
 * The columns, at module scope so the table is not rebuilt on every render.
 *
 * Level orders by the stored severity rather than by its own text, so descending puts errors
 * first — see `log-sort.ts`. The accessor still returns the level string, which is what the column
 * shows; the ordering it drives happens in the query.
 */
const columns: DataTableColumns<LogLine> = [
	{
		id: "time",
		header: "Time",
		accessorFn: (line) => line.at,
		meta: { headClassName: "w-[170px]", cellClassName: "font-mono text-[11px] text-subtle-foreground" },
		cell: ({ row }) => formatDateTime(row.original.at),
	},
	{
		id: "level",
		header: "Level",
		accessorFn: (line) => line.level,
		meta: { headClassName: "w-[80px]" },
		cell: ({ row }) => (
			<Badge variant="outline" className={`w-[62px] justify-center ${LEVEL_STYLE[row.original.level]}`}>
				{row.original.level.toLowerCase()}
			</Badge>
		),
	},
	{
		id: "source",
		header: "Source",
		accessorFn: (line) => line.agentName ?? "",
		meta: { headClassName: "w-[170px]", cellClassName: "truncate font-mono text-[11px] text-subtle-foreground" },
		cell: ({ row }) =>
			`${row.original.agentName ?? "—"}${row.original.deviceName ? `/${row.original.deviceName}` : ""}`,
	},
	{
		id: "message",
		header: "Message",
		accessorFn: (line) => line.message,
		meta: { cellClassName: "text-[12px]" },
		cell: ({ row }) => row.original.message,
	},
];

/**
 * The log, with new lines arriving as they are recorded.
 *
 * **New lines are prepended in place rather than triggering a page refresh.** A log that reloaded
 * on every line would be unreadable during the exact situation it exists for — a printer failing
 * repeatedly — because the list would jump under the cursor several times a second. Appending to
 * what is already rendered keeps scroll position and keeps the page cheap.
 *
 * Live lines are not filtered client-side. They arrive already narrowed by nothing, so a stream
 * showing lines the current filter excludes would be lying about what the filter means; instead
 * the stream is paused whenever a filter is set and the operator refreshes deliberately. A chosen
 * sort pauses it for the same reason: a line pushed onto the top of a list ordered by anything but
 * newest-first lands in the one place the ordering says it does not belong.
 *
 * Whether lines are taken at all is the Follow toggle's call, read from context rather than passed
 * down: the control sits on the filter row, which is this component's sibling. Nothing accumulates
 * while it is off, matching the header chip — someone who stopped the view wants it to hold still,
 * and what they missed is a reload away.
 */
export function LogStream({
	lines,
	sortable = true,
	resetOn,
}: {
	lines: LogLine[];
	sortable?: boolean;
	/**
	 * What clearing `arrived` should actually be keyed on, when that is not simply `lines` changing.
	 *
	 * The Logs tab's own wrapper (`log-list.tsx`) appends further pages onto `lines` as the operator
	 * scrolls an infinite-scrolled list, which changes `lines`' identity without meaning "a fresh
	 * authoritative snapshot arrived" — the arrived buffer is unrelated to whatever page just got
	 * appended, and clearing it there would silently drop lines the operator has not seen yet. That
	 * wrapper passes its own `batchVersion` here instead, which changes only when the *first* batch is
	 * actually replaced. Omitted by every other caller — the dashboard's tail included — which keeps
	 * their `lines` array itself as the signal, exactly as before this prop existed.
	 */
	resetOn?: unknown;
}) {
	const router = useRouter();
	const { following, streamable } = useFollow();
	const live = streamable && following;
	const [arrived, setArrived] = useState<LogLine[]>([]);

	// Lines that arrived live are dropped whenever a fresh authoritative snapshot arrives, since that
	// snapshot already contains them. Without this they would appear twice after any navigation.
	const resetSignal = resetOn ?? lines;
	useEffect(() => {
		setArrived([]);
	}, [resetSignal]);

	useEventStream(
		"log",
		(event) => {
			const payload = JSON.parse(event.data);
			setArrived((current) => [
				{
					id: payload.id,
					at: payload.at,
					level: payload.level,
					message: payload.message,
					agentName: null,
					deviceName: payload.deviceName,
					// LogEvent carries no apiKeyId — the live stream only ever fires from `agentId`-bearing
					// writes (see recordServerLog's doc comment) — so a live line is never an API key's.
					apiKeyId: null,
				},
				...current,
			]);
		},
		live,
	);

	const all = [...arrived, ...lines];

	return (
		<div className="flex flex-col gap-2">
			{arrived.length > 0 ? (
				<div className="flex items-center gap-2 text-[11.5px] text-subtle-foreground">
					<span>
						{arrived.length} new {arrived.length === 1 ? "line" : "lines"}
					</span>
					<Button variant="ghost" size="sm" className="h-6 text-[11.5px]" onClick={() => router.refresh()}>
						Reload
					</Button>
				</div>
			) : null}

			<DataTable
				rows={all}
				columns={columns}
				defaultSort={{ id: LOG_DEFAULT_SORT.column, desc: LOG_DEFAULT_SORT.desc }}
				// The line's own id, not its position: infinite scroll can reorder this list under a live
				// batch-0 replacement, and lines arriving live are prepended ahead of it too. See
				// `DataTable`'s own doc on `getRowId`.
				getRowId={(line) => line.id}
				minWidth="640px"
				sortable={sortable}
				empty={
					<Empty className="border border-dashed border-border">
						<EmptyHeader>
							<EmptyTitle>No log lines</EmptyTitle>
							<EmptyDescription>
								Agents forward what an operator would act on — jobs accepted and refused, ports opened and refused.
								Nothing has happened yet.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				}
			/>
		</div>
	);
}
