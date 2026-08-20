"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The value used for "no filter", since a select cannot hold an empty string as a choice. */
const ANY = "__any__";

/** One filterable dimension. */
export interface FilterOption {
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
 * Filters held in the URL rather than in component state.
 *
 * That makes a filtered view something an operator can bookmark, send to a colleague, and return
 * to after a reload — all of which matter when the thing being looked at is "why did the kitchen
 * printer fail twice this morning". It also means the server does the filtering, so the page
 * never holds more rows than it shows.
 */
export function Filters({ filters }: { filters: Filter[] }) {
	const router = useRouter();
	const params = useSearchParams();

	const set = (name: string, value: string): void => {
		const next = new URLSearchParams(params.toString());
		if (value === ANY) {
			next.delete(name);
		} else {
			next.set(name, value);
		}
		// Paging is meaningless once the filter changes: page three of the old result set is not
		// page three of the new one.
		next.delete("skip");
		router.push(`?${next.toString()}`);
	};

	const active = filters.some((filter) => filter.value !== null);

	return (
		<div className="flex flex-wrap items-center gap-2">
			{filters.map((filter) => (
				<FilterSelect key={filter.name} filter={filter} onChange={(value) => set(filter.name, value)} />
			))}

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
