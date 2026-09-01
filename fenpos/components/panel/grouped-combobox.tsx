"use client";

import { useMemo } from "react";
import {
	Combobox,
	ComboboxCollection,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxInput,
	ComboboxItem,
	ComboboxLabel,
	ComboboxList,
} from "@/components/ui/combobox";

/**
 * A long list of identifiers, picked by typing rather than by scrolling.
 *
 * Built for `panel.timezone` and `variables.timezone`, which offer every IANA zone this runtime
 * knows about — around four hundred of them. As a plain dropdown that is a column of near-identical
 * strings taller than the screen, ordered by a rule (`Africa` before `America` before `Antarctica`)
 * that only helps somebody who already knows which continent their answer is filed under.
 *
 * Two things fix it, and they are the same two the shadcn combobox exists for. **Typing filters**,
 * so "helsin" is three keystrokes instead of a scroll to the middle of Europe. And **the list is
 * grouped by area**, so what is left after filtering — or before typing anything — reads as a
 * handful of labelled regions rather than one undifferentiated run.
 *
 * The grouping is derived, not configured: everything before the first `/` is the group. That is
 * exactly the IANA `Area/Location` shape, and an identifier with no slash — `system`, `UTC` — falls
 * into {@link UNGROUPED}, which is rendered first because those are the two answers somebody who
 * does not want to think about zones at all is looking for.
 */

/** The group holding values that carry no area of their own. First, because it holds the defaults. */
const UNGROUPED = "General";

/** One area and the values filed under it. The shape Base UI wants for a grouped item list. */
interface Group {
	value: string;
	items: string[];
}

/**
 * Files values under the segment before their first `/`.
 *
 * Order within a group is the order given, which for `Intl.supportedValuesOf` is already
 * alphabetical. {@link UNGROUPED} is moved to the front; the rest keep the order their first member
 * appeared in, which for the same reason is alphabetical by area.
 *
 * @param values every value the setting accepts
 * @returns the groups to render
 */
function groupValues(values: readonly string[]): Group[] {
	const byArea = new Map<string, string[]>();
	for (const value of values) {
		const slash = value.indexOf("/");
		const area = slash === -1 ? UNGROUPED : value.slice(0, slash);
		const existing = byArea.get(area);
		if (existing) {
			existing.push(value);
		} else {
			byArea.set(area, [value]);
		}
	}

	const groups = [...byArea].map(([value, items]) => ({ value, items }));
	// Not a sort: every other group is already in the order it arrived, and re-sorting would claim
	// an opinion about area order this component does not have. Only the defaults are moved.
	const general = groups.findIndex((group) => group.value === UNGROUPED);
	if (general > 0) {
		groups.unshift(...groups.splice(general, 1));
	}
	return groups;
}

/**
 * Renders the picker.
 *
 * @param values every value the setting accepts
 * @param value the current one
 * @param onValueChange called with the new value; never with null, since one is always selected
 * @param disabled whether the control is inert, while a save is in flight
 * @param placeholder what the input reads while empty
 */
export function GroupedCombobox({
	values,
	value,
	onValueChange,
	disabled = false,
	placeholder = "Search…",
	id,
}: {
	values: readonly string[];
	value: string;
	onValueChange: (value: string) => void;
	disabled?: boolean;
	placeholder?: string;
	id?: string;
}) {
	// Keyed on the array itself: a setting's value list is built once by the server page and handed
	// down unchanged, so this runs once rather than on every keystroke in the field.
	const groups = useMemo(() => groupValues(values), [values]);

	return (
		<Combobox
			items={groups}
			value={value}
			disabled={disabled}
			onValueChange={(next) => {
				// Base UI types the value as nullable to cover "nothing selected". This combobox always
				// has a selection — a setting always holds a value — so only the non-null branch runs.
				if (typeof next === "string") {
					onValueChange(next);
				}
			}}
		>
			<ComboboxInput className="w-full font-mono" id={id} placeholder={placeholder} />
			<ComboboxContent>
				<ComboboxEmpty>No match.</ComboboxEmpty>
				<ComboboxList>
					{(group: Group) => (
						<ComboboxGroup key={group.value} items={group.items}>
							<ComboboxLabel>{group.value}</ComboboxLabel>
							<ComboboxCollection>
								{(item: string) => (
									<ComboboxItem key={item} value={item} className="font-mono">
										{item}
									</ComboboxItem>
								)}
							</ComboboxCollection>
						</ComboboxGroup>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}
