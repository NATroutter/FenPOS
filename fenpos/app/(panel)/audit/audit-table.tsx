"use client";

import { Info } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumns } from "@/components/ui/data-table";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { AuditEventSummary } from "@/lib/audit/audit-query";
import { AUDIT_DEFAULT_SORT } from "@/lib/audit/audit-sort";
import type { AuditOutcome } from "@/lib/domain/audit";
import { formatDateTime } from "@/lib/format/datetime";

/**
 * Chip styling per outcome.
 *
 * `DENIED` and `FAILURE` are told apart by colour as well as by word, because they are read for
 * different things: a page full of `DENIED` is somebody probing, and a page full of `FAILURE` is
 * something wrong with the install.
 */
const OUTCOME_STYLE: Record<AuditOutcome, string> = {
	SUCCESS: "border-emerald-900 bg-emerald-950 text-emerald-400",
	DENIED: "border-amber-900 bg-amber-950 text-amber-400",
	FAILURE: "border-destructive/40 bg-destructive/10 text-destructive",
};

/**
 * The columns, at module scope so the table is not rebuilt on every render.
 *
 * There is no action column beyond the detail button, and that absence is the tab's main statement:
 * no row has an edit path or a delete path, so there is nothing else one could offer. Audit history is
 * removed from the panel only a whole archived month at a time, on the Archives tab, under
 * `audit:archive-delete` — never a row, and never from here.
 */
const columns: DataTableColumns<AuditEventSummary> = [
	{
		id: "at",
		header: "When",
		accessorFn: (event) => event.at,
		meta: { headClassName: "w-[170px]", cellClassName: "text-[11.5px] text-muted-foreground" },
		cell: ({ row }) => formatDateTime(row.original.at),
	},
	{
		id: "actor",
		header: "Actor",
		accessorFn: (event) => event.actor,
		meta: { headClassName: "w-[180px]", cellClassName: "truncate text-[12px]" },
	},
	{
		id: "action",
		header: "Action",
		accessorFn: (event) => event.action,
		meta: { cellClassName: "font-mono text-[11.5px]" },
	},
	{
		id: "outcome",
		header: "Outcome",
		accessorFn: (event) => event.outcome,
		meta: { headClassName: "w-[110px]" },
		cell: ({ row }) => (
			<Badge variant="outline" className={OUTCOME_STYLE[row.original.outcome]}>
				{row.original.outcome.toLowerCase()}
			</Badge>
		),
	},
	{
		id: "target",
		header: "Target",
		// Not sortable: it renders whichever of three columns is populated, so a header arrow would
		// promise an ordering over something that is not one column.
		enableSorting: false,
		meta: { cellClassName: "truncate text-[12px]" },
		// Label, then id, then kind. The id matters more than it looks: a page view carries no label
		// and its `targetId` is the route, so falling straight through to `targetKind` rendered every
		// page view in the record as the word "page" — true, and useless.
		cell: ({ row }) => row.original.targetLabel ?? row.original.targetId ?? row.original.targetKind ?? "—",
	},
	{
		id: "detail",
		header: "",
		enableSorting: false,
		meta: { headClassName: "w-[60px]" },
		cell: ({ row }) => (
			<div className="flex justify-end">
				<EventDetail event={row.original} />
			</div>
		),
	},
];

/** The audit list. Not live: a record nobody can change does not need to refresh itself. */
export function AuditTable({ events }: { events: AuditEventSummary[] }) {
	return (
		<DataTable
			rows={events}
			columns={columns}
			defaultSort={{ id: AUDIT_DEFAULT_SORT.column, desc: AUDIT_DEFAULT_SORT.desc }}
			minWidth="900px"
			empty={
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyTitle>No events</EmptyTitle>
						<EmptyDescription>Nothing matches these filters.</EmptyDescription>
					</EmptyHeader>
				</Empty>
			}
		/>
	);
}

/**
 * One event in full, behind a button in the row.
 *
 * `detail` is the reason this dialog exists: it is the action's own parameters and, where it
 * mattered, what changed — far too long for a table cell and the whole answer to "what actually
 * happened here".
 */
function EventDetail({ event }: { event: AuditEventSummary }) {
	const [open, setOpen] = useState(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button
						variant="outline"
						size="icon"
						className="size-7"
						title="Details"
						aria-label={`Details for event ${event.seq}`}
					>
						<Info className="size-3" />
					</Button>
				}
			/>
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle className="font-mono text-[13px]">{event.action}</DialogTitle>
					<DialogDescription>
						{event.actor} · {event.outcome.toLowerCase()} · {formatDateTime(event.at)}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<dl className="grid grid-cols-2 gap-x-4 gap-y-3">
						<Field label="Sequence" value={String(event.seq)} />
						<Field label="Actor kind" value={event.actorKind} />
						<Field label="Email" value={event.actorEmail ?? "—"} />
						<Field label="Target" value={event.targetLabel ?? event.targetId ?? "—"} />
						<Field label="Address" value={event.ipAddress ?? "—"} />
						<Field label="Agent" value={event.userAgent ?? "—"} />
					</dl>
					{event.detail ? (
						<pre className="mt-4 max-h-[280px] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11.5px]">
							{prettyDetail(event.detail)}
						</pre>
					) : null}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Re-indents the stored JSON for reading.
 *
 * Falls back to the raw text rather than throwing: `detail` is truncated at 8,000 characters by
 * `recordAudit`, so a long one can be stored mid-token and will not parse. Showing the truncated text
 * is more useful than showing nothing, and much more useful than a crashed dialog.
 *
 * @param detail the stored JSON text
 * @returns it, indented if it parses
 */
function prettyDetail(detail: string): string {
	try {
		return JSON.stringify(JSON.parse(detail), null, 2);
	} catch {
		return detail;
	}
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<dt className="text-[11px] font-medium text-subtle-foreground">{label}</dt>
			<dd className="mt-0.5 truncate font-mono text-[12px]">{value}</dd>
		</div>
	);
}
