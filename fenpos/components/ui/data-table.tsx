"use client";

import {
	type ColumnDef,
	type OnChangeFn,
	type RowData,
	rowSortingFeature,
	type SortingState,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * A sortable table whose sort lives in the URL and is applied by the server.
 *
 * **`manualSorting` is not a detail — it is the point.** These lists are paged: the server sends
 * fifty jobs or a hundred log lines and says whether more follow. Sorting those rows in the browser
 * would order the page rather than the result, so "largest job" would mean "largest job among the
 * fifty you happen to be looking at" while presenting itself as the answer to the question actually
 * asked. The table therefore renders rows in the order it received them and reports clicks upward
 * as a URL change, which re-runs the query.
 *
 * Putting the sort in the URL rather than in component state is the same choice the filters made,
 * for the same reasons: a sorted view can be bookmarked and sent to someone else, and it survives
 * the reload that follows an operator fixing whatever they were looking for.
 *
 * Changing the sort drops `skip`, because page three of one ordering is not page three of another.
 */

/** The features this table registers. In v9 nothing is on unless asked for; sorting is all we use. */
const features = tableFeatures({ rowSortingFeature });

/** Column definitions for {@link DataTable}, bound to its feature set. */
export type DataTableColumns<TData extends RowData> = ColumnDef<typeof features, TData, unknown>[];

/**
 * Per-column presentation, carried on `meta` because it belongs to the column rather than to
 * every cell that column renders.
 */
export interface DataTableColumnMeta {
	/** Applied to the header cell — column widths live here. */
	headClassName?: string;
	/** Applied to every body cell in the column. */
	cellClassName?: string;
	/** Right-aligns the header's label and sort arrow, for numeric columns. */
	alignEnd?: boolean;
}

/** The sort a list falls back to when the URL names none. */
export interface DataTableSort {
	id: string;
	desc: boolean;
}

export function DataTable<TData extends RowData>({
	rows,
	columns,
	defaultSort,
	empty,
	className,
	minWidth,
	sortable = true,
}: {
	rows: TData[];
	columns: DataTableColumns<TData>;
	defaultSort: DataTableSort;
	/** Shown instead of the table when there is nothing to list. */
	empty: ReactNode;
	className?: string;
	/** Floor for the table's width, so columns do not crush before the wrapper scrolls. */
	minWidth?: string;
	/**
	 * Whether the headers sort. Off for a list whose page does not read `sort` from the URL —
	 * the dashboard's log tail is one, and left on it drew sortable headers that pushed a param
	 * the dashboard ignores, so the arrows moved and the rows did not.
	 */
	sortable?: boolean;
}) {
	const router = useRouter();
	const params = useSearchParams();

	const sortId = params.get("sort");
	const sorting: SortingState = sortId
		? [{ id: sortId, desc: params.get("dir") !== "asc" }]
		: [{ id: defaultSort.id, desc: defaultSort.desc }];

	const onSortingChange: OnChangeFn<SortingState> = (updater) => {
		const next = typeof updater === "function" ? updater(sorting) : updater;
		const chosen = next[0];
		const search = new URLSearchParams(params.toString());

		// Cycling past the last direction clears the sort rather than sticking, which is how a
		// reader gets back to the default order without knowing what it was.
		if (!chosen || (chosen.id === defaultSort.id && chosen.desc === defaultSort.desc)) {
			search.delete("sort");
			search.delete("dir");
		} else {
			search.set("sort", chosen.id);
			search.set("dir", chosen.desc ? "desc" : "asc");
		}
		search.delete("skip");

		const rendered = search.toString();
		router.push(rendered ? `?${rendered}` : "?");
	};

	const table = useTable({
		features,
		data: rows,
		columns,
		manualSorting: true,
		enableSorting: sortable,
		state: { sorting },
		onSortingChange,
	});

	if (rows.length === 0) {
		return empty;
	}

	return (
		<div className={cn("overflow-x-auto rounded-md border border-border bg-card", className)}>
			<Table style={minWidth ? { minWidth } : undefined}>
				<TableHeader>
					{table.getHeaderGroups().map((group) => (
						<TableRow key={group.id}>
							{group.headers.map((header) => {
								const meta = header.column.columnDef.meta as DataTableColumnMeta | undefined;
								const sorted = header.column.getIsSorted();

								return (
									<TableHead key={header.id} className={meta?.headClassName}>
										{header.column.getCanSort() ? (
											<button
												type="button"
												onClick={header.column.getToggleSortingHandler()}
												className={cn(
													"-mx-1 flex w-full items-center gap-1 rounded px-1 py-0.5 text-left transition-colors hover:text-foreground",
													meta?.alignEnd && "justify-end",
												)}
											>
												<table.FlexRender header={header} />
												{sorted === "asc" ? (
													<ArrowUp className="size-3 shrink-0" />
												) : sorted === "desc" ? (
													<ArrowDown className="size-3 shrink-0" />
												) : (
													// Held at low contrast rather than shown on hover alone: a control that
													// only exists once the pointer is over it is one a reader never learns is
													// there.
													<ChevronsUpDown className="size-3 shrink-0 text-subtle-foreground/50" />
												)}
											</button>
										) : (
											<table.FlexRender header={header} />
										)}
									</TableHead>
								);
							})}
						</TableRow>
					))}
				</TableHeader>

				<TableBody>
					{table.getRowModel().rows.map((row) => (
						<TableRow key={row.id}>
							{row.getAllCells().map((cell) => {
								const meta = cell.column.columnDef.meta as DataTableColumnMeta | undefined;
								return (
									<TableCell key={cell.id} className={meta?.cellClassName}>
										<table.FlexRender cell={cell} />
									</TableCell>
								);
							})}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
