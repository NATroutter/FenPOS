"use client";

import { useState, useTransition } from "react";
import {
	type ArchivePage,
	type ArchivePeriod,
	type ArchiveRef,
	type ArchiveRow,
	readArchivePage,
} from "@/app/(panel)/archives/actions";
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
 */
export function ArchiveTable({ periods }: { periods: ArchivePeriod[] }) {
	const [opened, setOpened] = useState<ArchiveRef | null>(null);
	const [search, setSearch] = useState("");
	const [skip, setSkip] = useState(0);
	/**
	 * The `skip` of each page walked past to reach this one.
	 *
	 * Stepping back needs the previous page's offset, and the page size is the server's — a
	 * `"use server"` module may export only functions, so it cannot be shared as a constant, and
	 * copying its value here would be a second spelling of one number. The trail sidesteps that: every
	 * offset it holds is one the server actually answered.
	 */
	const [trail, setTrail] = useState<number[]>([]);
	const [page, setPage] = useState<ArchivePage | null>(null);
	const [pending, startTransition] = useTransition();

	const load = (archive: ArchiveRef, text: string, from: number): void => {
		startTransition(async () => {
			setSkip(from);
			setPage(await readArchivePage(archive, { search: text, skip: from }));
		});
	};

	const open = (period: ArchivePeriod): void => {
		const archive = { source: period.source, periodKey: period.periodKey };
		setOpened(archive);
		setSearch("");
		setTrail([]);
		setPage(null);
		load(archive, "", 0);
	};

	const close = (): void => {
		setOpened(null);
		setPage(null);
	};

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
								<TableCell className="text-right">
									<Button variant="outline" size="sm" disabled={pending} onClick={() => open(period)}>
										Open
									</Button>
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
								setTrail([]);
								load(opened, search, 0);
							}}
						>
							<Input
								name="search"
								value={search}
								placeholder="Search this period"
								className="h-8 w-[220px] text-[12px]"
								onChange={(event) => setSearch(event.target.value)}
							/>
							<Button type="submit" variant="outline" size="sm" disabled={pending}>
								Search
							</Button>
						</form>
						<div className="flex-1" />
						{pending ? <Spinner className="size-4" /> : null}
						<Button variant="outline" size="sm" onClick={close}>
							Close
						</Button>
					</div>

					{page === null ? null : page.error !== null ? (
						<p className="text-[12px] text-destructive">{page.error}</p>
					) : page.rows.length === 0 ? (
						<p className="text-[12px] text-subtle-foreground">Nothing in this period matches.</p>
					) : (
						<OpenedRows rows={page.rows} />
					)}

					{page !== null && page.error === null && (trail.length > 0 || page.more) ? (
						<div className="flex items-center gap-2">
							{trail.length > 0 ? (
								<Button
									variant="outline"
									size="sm"
									disabled={pending}
									onClick={() => {
										const previous = trail[trail.length - 1];
										setTrail(trail.slice(0, -1));
										load(opened, search, previous);
									}}
								>
									Newer
								</Button>
							) : null}
							{page.more ? (
								<Button
									variant="outline"
									size="sm"
									disabled={pending}
									onClick={() => {
										setTrail([...trail, skip]);
										load(opened, search, skip + page.rows.length);
									}}
								>
									Older
								</Button>
							) : null}
						</div>
					) : null}
				</div>
			)}
		</div>
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
