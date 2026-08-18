"use client";

import { Ban } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelJob } from "@/app/(panel)/jobs/actions";
import { useEventStream } from "@/components/panel/event-stream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { JobStatus } from "@/lib/domain/enums";
import type { JobSummary } from "@/lib/jobs/job-service";

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
 * The job list.
 *
 * **Refreshes itself from the event stream rather than on a timer.** A job's whole life is
 * seconds long, so a poll slow enough to be polite would miss most of it and one fast enough to
 * catch it would hammer the database of an install that is doing nothing. The stream already
 * carries every state change, so the list reacts to exactly the changes that happened.
 */
export function JobTable({ jobs, live }: { jobs: JobSummary[]; live: boolean }) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();

	// Subscribed only while the header's live chip is on, so pausing genuinely stops the work
	// rather than just hiding its results.
	useEventStream("job", () => router.refresh(), live);

	if (jobs.length === 0) {
		return (
			<Empty className="border border-dashed border-border">
				<EmptyHeader>
					<EmptyTitle>No jobs</EmptyTitle>
					<EmptyDescription>
						Nothing matches these filters. Jobs appear here as soon as they are submitted.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="overflow-x-auto rounded-md border border-border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[120px]">Job</TableHead>
						<TableHead>Printer</TableHead>
						<TableHead className="w-[110px]">State</TableHead>
						<TableHead className="w-[90px] text-right">Lines</TableHead>
						<TableHead className="w-[100px] text-right">Bytes</TableHead>
						<TableHead className="w-[170px]">Submitted</TableHead>
						<TableHead className="w-[60px]" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{jobs.map((job) => (
						<TableRow key={job.id}>
							<TableCell className="font-mono text-[11.5px]">
								<JobDetail job={job} />
							</TableCell>
							<TableCell className="font-mono text-[11.5px]">
								{job.agentName}/{job.deviceName}
							</TableCell>
							<TableCell>
								<Badge variant="outline" className={STATUS_STYLE[job.status]}>
									{job.status.toLowerCase()}
								</Badge>
							</TableCell>
							<TableCell className="text-right font-mono text-[11.5px]">{job.lines ?? "—"}</TableCell>
							<TableCell className="text-right font-mono text-[11.5px]">{job.bytes ?? "—"}</TableCell>
							<TableCell className="text-[11.5px] text-muted-foreground">
								{new Date(job.submittedAt).toLocaleString()}
							</TableCell>
							<TableCell>
								{LIVE_STATUSES.includes(job.status) ? (
									<Button
										variant="outline"
										size="icon"
										className="size-7"
										title="Cancel"
										aria-label="Cancel job"
										disabled={pending}
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
								) : null}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

/**
 * One job's full record, behind its identifier.
 *
 * The failure message is the reason this dialog exists: it is the agent's own words about why
 * a receipt did not print, and it is far too long for a table cell.
 */
function JobDetail({ job }: { job: JobSummary }) {
	const [open, setOpen] = useState(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<button type="button" className="font-mono text-[11.5px] underline-offset-2 hover:underline">
						{job.id.slice(-8)}
					</button>
				}
			/>
			<DialogContent className="sm:max-w-[520px]">
				<DialogHeader>
					<DialogTitle className="font-mono text-[13px]">{job.id}</DialogTitle>
					<DialogDescription>
						{job.agentName}/{job.deviceName} · {job.status.toLowerCase()}
					</DialogDescription>
				</DialogHeader>

				<dl className="grid grid-cols-2 gap-x-4 gap-y-3">
					<Detail label="Submitted by" value={job.keyName ?? "Admin panel"} />
					<Detail label="Submitted" value={new Date(job.submittedAt).toLocaleString()} />
					<Detail label="Started" value={job.startedAt ? new Date(job.startedAt).toLocaleString() : "—"} />
					<Detail label="Finished" value={job.finishedAt ? new Date(job.finishedAt).toLocaleString() : "—"} />
					<Detail label="Lines" value={job.lines === null ? "—" : String(job.lines)} />
					<Detail label="Bytes" value={job.bytes === null ? "—" : String(job.bytes)} />
				</dl>

				{job.errorCode ? (
					<div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
						<div className="font-mono text-[11.5px] text-destructive">{job.errorCode}</div>
						<p className="mt-1 text-[12px] text-destructive">{job.errorMessage}</p>
					</div>
				) : null}
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
