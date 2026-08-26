"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type FilterOption, Filters } from "@/app/(panel)/jobs/filters";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The Audit tab's filter row.
 *
 * The three closed-set dimensions go through the Jobs tab's `Filters` unchanged — same URL contract,
 * same "changing a filter drops `skip`" rule — and the date range is added beside it rather than
 * folded into it, because a range is two values and that component's shape is one value per filter.
 *
 * Native `type="date"` inputs rather than a picker component: two fields do not justify a dependency,
 * and the native control is the one an operator's browser already localises for them.
 */
export function AuditFilters({
	actors,
	actions,
	outcomes,
	selected,
}: {
	actors: FilterOption[];
	actions: FilterOption[];
	outcomes: FilterOption[];
	selected: { actor: string | null; action: string | null; outcome: string | null; from: string; to: string };
}) {
	const router = useRouter();
	const params = useSearchParams();

	const setDate = (name: "from" | "to", value: string): void => {
		const next = new URLSearchParams(params.toString());
		if (value) {
			next.set(name, value);
		} else {
			next.delete(name);
		}
		// Page three of the old range is not page three of the new one.
		next.delete("skip");
		router.push(`?${next.toString()}`);
	};

	return (
		<div className="flex flex-wrap items-end gap-3">
			<Filters
				filters={[
					{ name: "actor", label: "Actor", value: selected.actor, options: actors },
					{ name: "action", label: "Action", value: selected.action, options: actions },
					{ name: "outcome", label: "Outcome", value: selected.outcome, options: outcomes },
				]}
			/>

			<div className="flex items-end gap-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor="audit-from" className="text-[11px] text-subtle-foreground">
						From
					</Label>
					<Input
						id="audit-from"
						type="date"
						value={selected.from}
						onChange={(changed) => setDate("from", changed.target.value)}
						className="h-8 w-[150px] text-[12px]"
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="audit-to" className="text-[11px] text-subtle-foreground">
						To
					</Label>
					<Input
						id="audit-to"
						type="date"
						value={selected.to}
						onChange={(changed) => setDate("to", changed.target.value)}
						className="h-8 w-[150px] text-[12px]"
					/>
				</div>
			</div>
		</div>
	);
}
