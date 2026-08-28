"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The value used for "no filter", since a select cannot hold an empty string as a choice. */
const ANY = "__any__";

/**
 * One filterable dimension.
 *
 * Module-local: the pages that use this component build their option arrays inline, in the `filters`
 * prop itself, so nothing outside needs the name. It was exported for `audit-filters.tsx`, which
 * declared the Audit tab's three dimensions as typed arguments; that component is gone, folded into
 * this one, and an export whose only importer was deleted is surface nothing is holding up.
 */
interface FilterOption {
	value: string;
	label: string;
}

/** One filter, as the page describes it. */
interface Filter {
	name: string;
	label: string;
	value: string | null;
	options: FilterOption[];
}

/**
 * A date range, as the page describes it: the `from` and `to` parameters' current values.
 *
 * Both are the `yyyy-mm-dd` a native date input reads and writes, empty when that end is unbounded.
 * The page turns them into instants with `dayBound` (`lib/format/datetime.ts`) — this component
 * only carries the strings, because they are exactly what lives in the URL.
 *
 * Module-local for the same reason {@link FilterOption} is: both pages pass an object literal.
 */
interface FilterRange {
	from: string;
	to: string;
}

/**
 * Filters held in the URL rather than in component state.
 *
 * That makes a filtered view something an operator can bookmark, send to a colleague, and return
 * to after a reload — all of which matter when the thing being looked at is "why did the kitchen
 * printer fail twice this morning". It also means the server does the filtering, so the page
 * never holds more rows than it shows.
 *
 * The optional date range is part of the same row, and follows the same two rules as every select
 * here: it writes straight into the URL, and it drops `skip` when it changes. It lives here rather
 * than beside this component so the Audit tab and the Logs tab read a range the same way — the two
 * pages that filter by one, and two spellings of one control is how they come to differ.
 *
 * Native `type="date"` inputs rather than a picker component: two fields do not justify a
 * dependency, and the native control is the one an operator's browser already localises for them.
 */
export function Filters({ filters, range }: { filters: Filter[]; range?: FilterRange }) {
	const router = useRouter();
	const params = useSearchParams();
	// Unique per instance, so two filter rows on one page cannot give two inputs the same id — which
	// would make a label point at whichever the browser found first.
	const field = useId();

	const set = (name: string, value: string | null): void => {
		const next = new URLSearchParams(params.toString());
		if (value === null) {
			next.delete(name);
		} else {
			next.set(name, value);
		}
		// Paging is meaningless once the filter changes: page three of the old result set is not
		// page three of the new one.
		next.delete("skip");
		router.push(`?${next.toString()}`);
	};

	const active = filters.some((filter) => filter.value !== null) || Boolean(range?.from) || Boolean(range?.to);

	return (
		<div className="flex flex-wrap items-end gap-2">
			{filters.map((filter) => (
				<FilterSelect
					key={filter.name}
					filter={filter}
					onChange={(value) => set(filter.name, value === ANY ? null : value)}
				/>
			))}

			{range === undefined ? null : (
				<div className="flex items-end gap-2">
					<div className="flex flex-col gap-1">
						<Label htmlFor={`${field}-from`} className="text-[11px] text-subtle-foreground">
							From
						</Label>
						<Input
							id={`${field}-from`}
							type="date"
							value={range.from}
							onChange={(changed) => set("from", changed.target.value || null)}
							className="h-8 w-[150px] text-[12px]"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor={`${field}-to`} className="text-[11px] text-subtle-foreground">
							To
						</Label>
						<Input
							id={`${field}-to`}
							type="date"
							value={range.to}
							onChange={(changed) => set("to", changed.target.value || null)}
							className="h-8 w-[150px] text-[12px]"
						/>
					</div>
				</div>
			)}

			{active ? (
				<Button variant="ghost" size="sm" className="h-8 text-[12px]" onClick={() => router.push("?")}>
					Clear
				</Button>
			) : null}
		</div>
	);
}

/**
 * One filter's dropdown.
 *
 * Its own component so the value-to-label map can be memoised per filter rather than rebuilt for
 * every filter on every render of the row.
 */
function FilterSelect({ filter, onChange }: { filter: Filter; onChange: (value: string) => void }) {
	// Base UI renders the raw value in the trigger unless the root is told what the values mean,
	// which is how three dropdowns came to read "__any__" instead of naming what they filter.
	const items = useMemo(
		() => ({
			[ANY]: `${filter.label}: any`,
			...Object.fromEntries(filter.options.map((option) => [option.value, option.label])),
		}),
		[filter.label, filter.options],
	);

	return (
		<Select items={items} value={filter.value ?? ANY} onValueChange={(next) => onChange(next ?? ANY)}>
			<SelectTrigger className="h-8 w-auto min-w-[140px] text-[12px]">
				<SelectValue placeholder={filter.label} />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ANY}>{filter.label}: any</SelectItem>
				{filter.options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
