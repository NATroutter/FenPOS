"use client";

import { Ban, Info } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelJob } from "@/app/(panel)/jobs/actions";
import { useEventStream } from "@/components/panel/event-stream";
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
import type { JobStatus } from "@/lib/domain/enums";
import { formatDateTime } from "@/lib/format/datetime";
import type { JobSummary } from "@/lib/jobs/job-service";
import { JOB_DEFAULT_SORT } from "@/lib/jobs/job-sort";

/** Chip styling per job state. */
const STATUS_STYLE: Record<JobStatus, string> = {
	QUEUED: "border-border bg-muted text-muted-foreground",
	PRINTING: "border-sky-900 bg-sky-950 text-sky-400",
	COMPLETED: "border-emerald-900 bg-emerald-950 text-emerald-400",
	FAILED: "border-destructive/40 bg-destructive/10 text-destructive",
	CANCELLED: "border-amber-900 bg-amber-950 text-amber-400",
};

/** States that can still change, and so are worth refreshing for. */
const LIVE_STATUSES: JobStatus[] = ["QUEUED", "PRINTING"];

/**
 * The columns, at module scope so the table is not rebuilt on every render.
 *
 * `id` and the action column are not sortable. The identifier is a cuid, which orders by nothing
 * a reader could predict; the actions are buttons, not data.
 *
 * Sorting `state` orders by the stored string, so the sequence is alphabetical — cancelled,
 * completed, failed, printing, queued — rather than by any notion of progress. That is a real
 * ordering and a stable one, which is what the column is for: grouping every failure together.
 *
 * A function of one permission, but still module scope: both answers are built once, below, and the
 * component picks between them rather than rebuilding either.
 */
const columnsFor = (canCancel: boolean): DataTableColumns<JobSummary> => [
	{
		id: "id",
		header: "Job",
		enableSorting: false,
		meta: { headClassName: "w-[120px]", cellClassName: "font-mono text-[11.5px]" },
		// Plain text, not a button: the identifier is what an operator copies into a support thread,
		// and selecting it should not open a dialog. Details live in the actions column, where a
		// button looks like one.
		cell: ({ row }) => row.original.id.slice(-8),
	},
	{
		id: "printer",
		header: "Printer",
		accessorFn: (job) => `${job.agentName}/${job.deviceName}`,
		meta: { cellClassName: "font-mono text-[11.5px]" },
	},
	{
		id: "status",
		header: "State",
		accessorFn: (job) => job.status,
		meta: { headClassName: "w-[110px]" },
		cell: ({ row }) => (
			<Badge variant="outline" className={STATUS_STYLE[row.original.status]}>
				{row.original.status.toLowerCase()}
			</Badge>
		),
	},
	{
		id: "lines",
		header: "Lines",
		accessorFn: (job) => job.lines,
		meta: { headClassName: "w-[90px]", cellClassName: "text-right font-mono text-[11.5px]", alignEnd: true },
		cell: ({ row }) => row.original.lines ?? "—",
	},
	{
		id: "bytes",
		header: "Bytes",
		accessorFn: (job) => job.bytes,
		meta: { headClassName: "w-[100px]", cellClassName: "text-right font-mono text-[11.5px]", alignEnd: true },
		cell: ({ row }) => row.original.bytes ?? "—",
	},
	{
		id: "submitted",
		header: "Submitted",
		accessorFn: (job) => job.submittedAt,
		meta: { headClassName: "w-[170px]", cellClassName: "text-[11.5px] text-muted-foreground" },
		cell: ({ row }) => formatDateTime(row.original.submittedAt),
	},
	{
		id: "actions",
		header: "",
		enableSorting: false,
		// Narrower without Cancel, so the column is the width of what is in it rather than of what
		// used to be. Details stays either way: it is the job's own record, which is what `jobs:read`
		// is for.
		meta: { headClassName: canCancel ? "w-[100px]" : "w-[64px]" },
		cell: ({ row }) => (
			<div className="flex items-center justify-end gap-1.5">
				<JobDetail job={row.original} />
				{canCancel ? <CancelJobButton job={row.original} /> : null}
			</div>
		),
	},
];

/** Both column sets, built once. See {@link columnsFor}. */
const COLUMNS = { withCancel: columnsFor(true), readOnly: columnsFor(false) };

/**
 * The job list.
 *
 * **Refreshes itself from the event stream rather than on a timer.** A job's whole life is
 * seconds long, so a poll slow enough to be polite would miss most of it and one fast enough to
 * catch it would hammer the database of an install that is doing nothing. The stream already
 * carries every state change, so the list reacts to exactly the changes that happened.
 */
export function JobTable({ jobs, live, canCancel }: { jobs: JobSummary[]; live: boolean; canCancel: boolean }) {
	const router = useRouter();

	// Subscribed only while the header's live chip is on, so pausing genuinely stops the work
	// rather than just hiding its results.
	useEventStream("job", () => router.refresh(), live);

	return (
		<DataTable
			rows={jobs}
			columns={canCancel ? COLUMNS.withCancel : COLUMNS.readOnly}
			defaultSort={{ id: JOB_DEFAULT_SORT.column, desc: JOB_DEFAULT_SORT.desc }}
			minWidth="880px"
			empty={
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyTitle>No jobs</EmptyTitle>
						<EmptyDescription>
							Nothing matches these filters. Jobs appear here as soon as they are submitted.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			}
		/>
	);
}

/**
 * One job's full record, behind a button in the row's action column.
 *
 * The failure message is the reason this dialog exists: it is the agent's own words about why
 * a receipt did not print, and it is far too long for a table cell.
 *
 * It used to hang off the job identifier, underlined on hover — which meant the only route to
 * the reason a receipt failed was clicking something that did not look clickable until the
 * pointer was already on it. A button next to Cancel is a button.
 */
function JobDetail({ job }: { job: JobSummary }) {
	const [open, setOpen] = useState(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button
						variant="outline"
						size="icon"
						className={
							job.errorCode ? "size-7 border-destructive/40 text-destructive hover:bg-destructive/10" : "size-7"
						}
						title="Details"
						aria-label={`Details for job ${job.id.slice(-8)}`}
					>
						<Info className="size-3" />
					</Button>
				}
			/>
			<DialogContent className="sm:max-w-[520px]">
				<DialogHeader>
					<DialogTitle className="font-mono text-[13px]">{job.id}</DialogTitle>
					<DialogDescription>
						{job.agentName}/{job.deviceName} · {job.status.toLowerCase()}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<dl className="grid grid-cols-2 gap-x-4 gap-y-3">
						<Detail label="Submitted by" value={job.keyName ?? "Admin panel"} />
						<Detail label="Submitted" value={formatDateTime(job.submittedAt)} />
						<Detail label="Started" value={job.startedAt ? formatDateTime(job.startedAt) : "—"} />
						<Detail label="Finished" value={job.finishedAt ? formatDateTime(job.finishedAt) : "—"} />
						<Detail label="Lines" value={job.lines === null ? "—" : String(job.lines)} />
						<Detail label="Bytes" value={job.bytes === null ? "—" : String(job.bytes)} />
					</dl>
					{job.errorCode ? (
						<div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
							<div className="font-mono text-[11.5px] text-destructive">{job.errorCode}</div>
							<p className="mt-1 text-[12px] text-destructive">{job.errorMessage}</p>
						</div>
					) : null}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<dt className="text-[11px] font-medium text-subtle-foreground">{label}</dt>
			<dd className="mt-0.5 truncate font-mono text-[12px]">{value}</dd>
		</div>
	);
}

/**
 * Cancel, with its own pending state.
 *
 * Per row rather than shared with the table: one transition covering the whole list disabled every
 * Cancel button while any one of them was in flight, which reads as the table having stopped
 * working rather than as one job being dealt with.
 *
 * Always drawn, disabled once the job has stopped moving. Rendering it only for live jobs made
 * every row a different shape and shifted the details button under the pointer as rows completed.
 */
function CancelJobButton({ job }: { job: JobSummary }) {
	const [pending, startTransition] = useTransition();
	const cancellable = LIVE_STATUSES.includes(job.status);

	return (
		<Button
			variant="outline"
			size="icon"
			className="size-7"
			title="Cancel"
			aria-label="Cancel job"
			disabled={pending || !cancellable}
			onClick={() =>
				startTransition(async () => {
					const result = await cancelJob(job.id);
					if (result.error) {
						toast.error(result.error);
					} else {
						toast.success("Cancellation requested.");
					}
				})
			}
		>
			<Ban className="size-3" />
		</Button>
	);
}
