"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { joinValues } from "@/lib/table/multi-filter";
import { cn } from "@/lib/utils";

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
	/** Everything currently ticked. Empty means this dimension is not narrowing anything. */
	values: string[];
	options: FilterOption[];
}

/**
 * A date range, as the page describes it: the `from` and `to` parameters' current values.
 *
 * Both are `yyyy-mm-dd`, empty when that end is unbounded. The page turns them into instants with
 * `dayBound` (`lib/format/datetime.ts`) — this component only carries the strings, because they are
 * exactly what lives in the URL.
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
 * **Every dropdown is multi-select, and every one carries its own label above it.** Both of those
 * replace one thing: a single-choice dropdown whose first item was `Level: any`, doing the work of
 * a label from inside the list it was labelling. So the trigger read "Level: any" when nothing was
 * chosen and "warn" when something was, which named the dimension only while it was not being used
 * — and the moment two of the four levels were interesting, the operator had to look at them one
 * page load at a time. The label is a label now, the list holds only real choices, and unticking
 * the last one is what "any" means.
 *
 * The optional date range is part of the same row and follows the same two rules as every select
 * here: it writes straight into the URL, and it drops `skip` when it changes. It lives here rather
 * than beside this component so the Audit tab and the Logs tab read a range the same way — the two
 * pages that filter by one, and two spellings of one control is how they come to differ.
 *
 * The two ends are {@link DatePicker}s, not `<input type="date">`. The native control is drawn by
 * the browser, so it arrived in whatever shape the operator's browser felt like and matched nothing
 * else in the row beside it. They still carry the same `yyyy-MM-dd` strings, because that is what
 * the URL holds.
 */
export function Filters({ filters, range }: { filters: Filter[]; range?: FilterRange }) {
	const router = useRouter();
	const params = useSearchParams();
	// Unique per instance, so two filter rows on one page cannot give two controls the same id.
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

	const active = filters.some((filter) => filter.values.length > 0) || Boolean(range?.from) || Boolean(range?.to);

	return (
		<div className="flex flex-wrap items-end gap-2">
			{filters.map((filter) => (
				<FilterSelect
					key={filter.name}
					filter={filter}
					id={`${field}-${filter.name}`}
					onChange={(values) => set(filter.name, joinValues(values))}
				/>
			))}

			{range === undefined ? null : (
				<div className="flex items-end gap-2">
					{/*
					 * Plain spans rather than `<Label htmlFor>`, here and over every select above: what
					 * these sit on top of is a button, not a form control a `for` can point at. What names
					 * each one for a screen reader is the control's own `label` or `aria-label`.
					 */}
					<div className="flex flex-col gap-1">
						<span className={LABEL}>From</span>
						<DatePicker
							clearable
							id={`${field}-from`}
							label="From date"
							placeholder="Any"
							value={range.from}
							onChange={(next) => set("from", next || null)}
							className="h-8 w-[150px] text-[12px]"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className={LABEL}>To</span>
						<DatePicker
							clearable
							id={`${field}-to`}
							label="To date"
							placeholder="Any"
							value={range.to}
							onChange={(next) => set("to", next || null)}
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

/** One rule for every label in the row, so the selects and the dates cannot drift apart. */
const LABEL = "text-[11px] text-subtle-foreground";

/**
 * One filter's dropdown, holding as many values as the operator ticks.
 *
 * There is no "any" item. An item meaning "clear the other items" inside a list of things to tick
 * is the confusing half of what this replaced; here, ticking nothing is what any means, and the
 * row's own Clear puts every dimension back at once.
 */
function FilterSelect({ filter, id, onChange }: { filter: Filter; id: string; onChange: (values: string[]) => void }) {
	// The trigger draws its own text rather than using `SelectValue`: with `multiple` the value is an
	// array, and past one choice the useful thing to say is how many rather than which — the options
	// are agent names and action identifiers, and two of those do not fit in a trigger this wide.
	const chosen = filter.options.filter((option) => filter.values.includes(option.value));
	const summary = chosen.length === 0 ? "Any" : chosen.length === 1 ? chosen[0].label : `${chosen.length} selected`;

	return (
		<div className="flex flex-col gap-1">
			<span className={LABEL}>{filter.label}</span>
			<Select multiple value={filter.values} onValueChange={(next) => onChange(next as string[])}>
				<SelectTrigger aria-label={filter.label} id={id} className="h-8 w-auto min-w-[140px] text-[12px]">
					<span className={cn("truncate", chosen.length === 0 && "text-muted-foreground")}>{summary}</span>
				</SelectTrigger>
				<SelectContent>
					{filter.options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
