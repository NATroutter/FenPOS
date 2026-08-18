"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The value used for "no filter", since a select cannot hold an empty string as a choice. */
const ANY = "__any__";

/** One filterable dimension. */
export interface FilterOption {
	value: string;
	label: string;
}

/**
 * Filters held in the URL rather than in component state.
 *
 * That makes a filtered view something an operator can bookmark, send to a colleague, and return
 * to after a reload — all of which matter when the thing being looked at is "why did the kitchen
 * printer fail twice this morning". It also means the server does the filtering, so the page
 * never holds more rows than it shows.
 */
export function Filters({
	filters,
}: {
	filters: { name: string; label: string; value: string | null; options: FilterOption[] }[];
}) {
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
				<Select key={filter.name} value={filter.value ?? ANY} onValueChange={(next) => set(filter.name, next ?? ANY)}>
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
			))}

			{active ? (
				<Button variant="ghost" size="sm" className="h-8 text-[12px]" onClick={() => router.push("?")}>
					Clear
				</Button>
			) : null}
		</div>
	);
}
