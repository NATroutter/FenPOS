"use client";

import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate } from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

/**
 * A date field: a button that reads the date, and a calendar in a popover.
 *
 * The shadcn composition — `Popover` around `Calendar` — rather than `<input type="date">`. The
 * native control renders as whatever the operator's browser decides, which on this panel meant a
 * grey box with a Chrome-blue focus ring and a system calendar in the middle of a dark dialog that
 * matched nothing around it. It also differed between browsers, so no two operators saw the same
 * screen.
 *
 * **It speaks `yyyy-MM-dd`, the same strings the native input did.** Every caller was already
 * holding one — the filters put theirs straight into the URL, the ban dialog turns its into an
 * instant — so the swap is the control, not the data.
 *
 * **Dates are read and written on the local calendar, never through UTC.** `new Date("2026-09-02")`
 * parses as midnight UTC and comes back as the 1st anywhere west of Greenwich, which is how a date
 * picker ends up highlighting the day before the one it was given. {@link toValue} and
 * {@link fromValue} below go through the local year/month/day components instead, and
 * {@link fromValue} anchors at midday so that formatting the result under a `panel.timezone` some
 * hours from the host's cannot roll it onto a neighbouring date either.
 *
 * The trigger's text comes from `formatDate`, so a date here reads exactly as the same date reads
 * in the table underneath it, `panel.locale` and all.
 */

/** Turns a Date into the `yyyy-MM-dd` a caller stores, on the local calendar. */
function toValue(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Turns a stored `yyyy-MM-dd` back into a Date at local midday.
 *
 * Undefined for an empty or unreadable value, which is what `Calendar` wants for "nothing selected"
 * — an Invalid Date passed as `selected` renders a calendar with no month at all.
 */
function fromValue(value: string): Date | undefined {
	const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (parts === null) {
		return undefined;
	}
	const at = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12);
	return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * Renders a date field.
 *
 * @param value the current date as `yyyy-MM-dd`, or `""` when there is none
 * @param onChange called with the new `yyyy-MM-dd`, or `""` when the date is cleared
 * @param label what this field is, for a screen reader — the trigger reads a date, which does not
 *   say whether it is the start of a range or the end
 * @param placeholder what the trigger reads while empty
 * @param clearable whether the popover offers a Clear. A filter can go back to unbounded; a field
 *   the form requires cannot, so it is off by default
 */
export function DatePicker({
	id,
	value,
	onChange,
	label,
	placeholder = "Pick a date",
	disabled = false,
	clearable = false,
	className,
}: {
	id?: string;
	value: string;
	onChange: (value: string) => void;
	label: string;
	placeholder?: string;
	disabled?: boolean;
	clearable?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const selected = fromValue(value);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				aria-label={label}
				disabled={disabled}
				id={id}
				render={<Button type="button" variant="outline" />}
				className={cn("justify-start gap-2 font-normal", selected === undefined && "text-muted-foreground", className)}
			>
				<CalendarIcon className="size-3.5 shrink-0" />
				<span className="truncate">{selected === undefined ? placeholder : formatDate(selected)}</span>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-auto p-0">
				<Calendar
					autoFocus
					mode="single"
					selected={selected}
					defaultMonth={selected}
					onSelect={(next) => {
						if (next === undefined) {
							return;
						}
						onChange(toValue(next));
						setOpen(false);
					}}
				/>
				{/*
				 * Clearing lives in the popover rather than as an X on the trigger: the trigger is
				 * already a button, and a second button inside it is markup no screen reader can read
				 * and no keyboard can reach in an order that makes sense.
				 */}
				{clearable && selected !== undefined ? (
					<div className="border-t border-border p-1.5">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="w-full"
							onClick={() => {
								onChange("");
								setOpen(false);
							}}
						>
							Clear
						</Button>
					</div>
				) : null}
			</PopoverContent>
		</Popover>
	);
}
