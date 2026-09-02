"use client";

import { Trash2 } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	type ArchivePeriod,
	type ArchiveRef,
	type ArchiveRow,
	deleteAuditArchive,
	readArchivePage,
} from "@/app/(panel)/archives/actions";
import {
	BackToTop,
	type InfiniteBatch,
	InfiniteScrollFooter,
	useInfiniteScroll,
} from "@/components/panel/infinite-scroll";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeBytes } from "@/lib/format/bytes";
import { formatDateTime } from "@/lib/format/datetime";

/** Styling for the two columns that are context rather than content: a moment, and a file's size. */
const MUTED_CELL = "text-[11.5px] text-muted-foreground";

/**
 * The archived periods, and one of them opened.
 *
 * **Nothing is read until somebody picks a period.** The list is a directory listing; opening a
 * period decompresses a whole month into a temporary file before it can answer a single question, so
 * that happens on a button press and on a submitted search, never as the page renders and never per
 * keystroke. That is the same reason the search box is a form rather than an input with a change
 * handler: a search that ran as an operator typed would decompress the period once per character.
 *
 * The two sources render different columns, because they are read for different questions — a log
 * line for its message, a recorded event for who did what and whether it worked.
 *
 * **Scrolls rather than pages, once a period is open.** `OpenedArchivePeriod` below reads it through
 * `readArchivePage` the same way this always has — `search` and `skip` — but the old Newer/Older
 * buttons are gone in favour of a sentinel, matching the other three tabs. There is no "Newer" here
 * because there does not need to be one: scrolling only ever adds to what is already on screen, so
 * whatever an operator scrolled past is still sitting above, right where it was.
 */
export function ArchiveTable({
	periods,
	error,
	canDelete,
}: {
	periods: ArchivePeriod[];
	error: string | null;
	/** Whether the operator holds `audit:archive-delete`. */
	canDelete: boolean;
}) {
	const [opened, setOpened] = useState<ArchiveRef | null>(null);
	const [search, setSearch] = useState("");
	const [submittedSearch, setSubmittedSearch] = useState("");
	/**
	 * Bumped on every fresh read — opening a period, or submitting a search over one already open.
	 *
	 * `OpenedArchivePeriod` is keyed by this alongside `opened`, so either kind of change remounts it
	 * with a clean slate: a new period or a new search is a new query, not more of the one already on
	 * screen, and reconciling scroll history across that boundary the way a live refresh is reconciled
	 * would mix two unrelated result sets. See `components/panel/infinite-scroll.tsx`'s module doc.
	 */
	const [generation, setGeneration] = useState(0);

	const open = (period: ArchivePeriod): void => {
		setOpened({ source: period.source, periodKey: period.periodKey });
		setSearch("");
		setSubmittedSearch("");
		setGeneration((value) => value + 1);
	};

	const close = (): void => {
		setOpened(null);
	};

	/**
	 * Closes the reader when the period it is showing has just been deleted.
	 *
	 * Only that period: a reader left open on a file that no longer exists would answer every page and
	 * every search with "no archive on disk", and closing whichever period happened to be open would
	 * throw away a search somebody is in the middle of.
	 */
	const closeIfOpen = (period: ArchivePeriod): void => {
		if (opened?.source === period.source && opened.periodKey === period.periodKey) {
			close();
		}
	};

	// The failure is shown before the list is judged empty, and it replaces the empty state rather than
	// sitting above it: "nothing has been archived yet" is a claim about the record, and a directory the
	// server could not read is precisely the case where nobody knows whether it is true.
	if (error !== null) {
		return (
			<Empty className="border border-dashed border-destructive/40">
				<EmptyHeader>
					<EmptyTitle>The archives could not be listed</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	if (periods.length === 0) {
		return (
			<Empty className="border border-dashed border-border">
				<EmptyHeader>
					<EmptyTitle>Nothing archived yet</EmptyTitle>
					<EmptyDescription>
						A period appears here once it has aged out of the live databases and been written to a file.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			<div className="overflow-x-auto rounded-md border border-border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-[140px]">Period</TableHead>
							<TableHead className="w-[110px]">Source</TableHead>
							<TableHead className="w-[110px]">Size</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{periods.map((period) => (
							<TableRow key={`${period.source}-${period.periodKey}`}>
								<TableCell className="font-mono text-[12px]">{period.periodKey}</TableCell>
								<TableCell>
									<Badge variant="outline">{period.source}</Badge>
								</TableCell>
								<TableCell className={MUTED_CELL}>{describeBytes(period.bytes)}</TableCell>
								<TableCell>
									<div className="flex items-center justify-end gap-1.5">
										<Button variant="outline" size="sm" onClick={() => open(period)}>
											Open
										</Button>
										{/* Only audit periods, because only they have a delete: a log archive ages out on the
										    maintenance pass, and there is no action to remove one by hand. And only for a
										    holder of `audit:archive-delete`, which is held apart from reading the record
										    precisely because this destroys evidence. */}
										{period.source === "audit" && canDelete ? (
											<DeleteAuditPeriod periodKey={period.periodKey} onDeleted={() => closeIfOpen(period)} />
										) : null}
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>

			{opened === null ? null : (
				<div className="flex flex-col gap-3 rounded-md border border-border p-4">
					<div className="flex flex-wrap items-center gap-3">
						<h2 className="font-mono text-[13px]">
							{opened.source} · {opened.periodKey}
						</h2>
						<form
							className="flex items-center gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								setSubmittedSearch(search);
								setGeneration((value) => value + 1);
							}}
						>
							<Input
								name="search"
								value={search}
								placeholder="Search this period"
								className="h-8 w-[220px] text-[12px]"
								onChange={(event) => setSearch(event.target.value)}
							/>
							<Button type="submit" variant="outline" size="sm">
								Search
							</Button>
						</form>
						<div className="flex-1" />
						<Button variant="outline" size="sm" onClick={close}>
							Close
						</Button>
					</div>

					<OpenedArchivePeriod
						// A new period or a new submitted search is a new query — see the `generation` doc above.
						key={`${opened.source}-${opened.periodKey}-${generation}`}
						archive={opened}
						search={submittedSearch}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * The one control on this tab that removes anything.
 *
 * Behind a confirmation, because this is the panel's only deliberate destruction of evidence: log
 * archives age out on a timer, audit archives never do, and what goes here does not come back. The
 * rule about *which* period may go is stated in the dialog and enforced only on the server — a button
 * that hid itself according to a second copy of the rule would be a second authority on it, and the
 * one that matters is the one holding the file.
 *
 * @param periodKey the audit period this button would remove
 * @param onDeleted run once the period is gone, so a reader open on it can close
 */
function DeleteAuditPeriod({ periodKey, onDeleted }: { periodKey: string; onDeleted: () => void }) {
	const [pending, startTransition] = useTransition();

	return (
		<AlertDialog>
			<AlertDialogTrigger
				disabled={pending}
				render={
					<Button
						variant="outline"
						size="icon"
						className="size-8 border-destructive/40 text-destructive hover:bg-destructive/10"
						title="Delete this archived period"
						aria-label={`Delete the audit archive for ${periodKey}`}
					>
						{pending ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" />}
					</Button>
				}
			/>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete the audit archive for {periodKey}?</AlertDialogTitle>
					<AlertDialogDescription>
						These events exist nowhere else, and nothing can restore them. Verification will report the record as
						beginning after them from now on, and this deletion is itself written into the record. Only the oldest
						archived period can be deleted, and never the newest.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						className="bg-destructive text-white hover:bg-destructive/90"
						onClick={() =>
							startTransition(async () => {
								const result = await deleteAuditArchive(periodKey);
								if (result.error) {
									toast.error(result.error);
								} else {
									toast.success(`The audit archive for ${periodKey} was deleted.`);
									onDeleted();
								}
							})
						}
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/**
 * One opened period's rows, scrolling in as the operator nears the bottom.
 *
 * Remounted by its own `key` (see `ArchiveTable`) whenever the period or the search changes, so this
 * always starts from nothing and asks `readArchivePage` for offset zero itself — through the same
 * `loadMore` the sentinel calls for every batch after it. There is no server-rendered first batch to
 * seed this with, unlike Jobs, Logs and Audit: opening a period is a client action, not something the
 * Archives page pre-fetches, so the seed here is simply empty with `more: true`, and the sentinel's
 * own first approach (immediate, since an empty list has nowhere to scroll before it) fetches page one.
 */
function OpenedArchivePeriod({ archive, search }: { archive: ArchiveRef; search: string }) {
	// A stable seed rather than a literal in the hook call: `useInfiniteScroll` compares `batch` by
	// identity to detect a fresh server-provided batch 0, and a literal would look like a new one on
	// every render of this component, wiping `more` and `error` back to their initial values each time.
	const seed = useRef<InfiniteBatch<ArchiveRow>>({ rows: [], more: true }).current;

	const { rows, more, loading, error, sentinelRef, retry } = useInfiniteScroll<ArchiveRow>({
		batch: seed,
		getId: (row) => row.id,
		loadMore: async (offset) => {
			const result = await readArchivePage(archive, { search, skip: offset });
			return { rows: result.rows, more: result.more, error: result.error };
		},
	});

	if (rows.length === 0) {
		if (loading) {
			return (
				<div className="flex justify-center py-6">
					<Spinner className="size-4" />
				</div>
			);
		}
		if (error) {
			return <p className="text-[12px] text-destructive">{error}</p>;
		}
		return <p className="text-[12px] text-subtle-foreground">Nothing in this period matches.</p>;
	}

	return (
		<>
			<OpenedRows rows={rows} />
			<InfiniteScrollFooter more={more} loading={loading} error={error} sentinelRef={sentinelRef} onRetry={retry} />
			<BackToTop />
		</>
	);
}

/**
 * The rows of an opened period, in whichever set of columns its source calls for.
 *
 * The union is discriminated on the first row rather than per row: an archive holds one table, so a
 * page cannot mix the two, and a header that had to be decided per row would have nothing to be.
 */
function OpenedRows({ rows }: { rows: ArchiveRow[] }) {
	const audit = rows[0].kind === "audit";

	return (
		<div className="overflow-x-auto rounded-md border border-border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[170px]">When</TableHead>
						{audit ? (
							<>
								<TableHead className="w-[180px]">Actor</TableHead>
								<TableHead>Action</TableHead>
								<TableHead className="w-[110px]">Outcome</TableHead>
								<TableHead>Target</TableHead>
							</>
						) : (
							<>
								<TableHead className="w-[90px]">Level</TableHead>
								<TableHead>Message</TableHead>
								<TableHead className="w-[160px]">Agent</TableHead>
							</>
						)}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.id}>
							<TableCell className={MUTED_CELL}>{formatDateTime(row.at)}</TableCell>
							{row.kind === "audit" ? (
								<>
									<TableCell className="truncate text-[12px]">{row.actor}</TableCell>
									<TableCell className="font-mono text-[11.5px]">{row.action}</TableCell>
									<TableCell className="text-[12px]">{row.outcome.toLowerCase()}</TableCell>
									<TableCell className="truncate text-[12px]">{row.target ?? "—"}</TableCell>
								</>
							) : (
								<>
									<TableCell className="text-[12px]">{row.level.toLowerCase()}</TableCell>
									<TableCell className="font-mono text-[11.5px]">{row.message}</TableCell>
									<TableCell className="truncate text-[12px]">{row.origin ?? "—"}</TableCell>
								</>
							)}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
