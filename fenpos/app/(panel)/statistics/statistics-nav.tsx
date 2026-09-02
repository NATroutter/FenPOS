"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { TAB_LABELS, TABS, type TabId } from "@/app/(panel)/statistics/tabs";
import { Button } from "@/components/ui/button";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/ui/combobox";
import { DatePicker } from "@/components/ui/date-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatDate } from "@/lib/format/datetime";
import type { RangePreset } from "@/lib/metrics/range";
import { cn } from "@/lib/utils";

/** The presets `resolveRange` (`lib/metrics/range.ts`) recognises, in the order the strip offers them. */
const RANGE_PRESETS: readonly RangePreset[] = ["24h", "7d", "30d", "90d", "1y"];

function isRangePreset(value: string | undefined): value is RangePreset {
	return value !== undefined && (RANGE_PRESETS as readonly string[]).includes(value);
}

/** One agent or device, as the filter comboboxes need it. */
interface Entity {
	id: string;
	name: string;
}

/** One rule for every label above a control in this strip, matching `app/(panel)/jobs/filters.tsx`. */
const LABEL = "text-[11px] text-subtle-foreground";

/**
 * The Statistics page's control strip: the tab strip, the range presets and custom-range popover,
 * and the agent/device filter — every one of them a URL rewrite, never component state.
 *
 * That is what makes a filtered, ranged view of one tab something an operator can bookmark or send
 * to a colleague, the same reasoning `Filters` on the Jobs tab already follows. `params` is exactly
 * what the server read `searchParams` as; every control here changes only the key(s) it owns and
 * carries every other key — including ones this component names no control for — forward untouched.
 *
 * **A valid `range` always wins over `from`/`to`, matching `resolveRange`.** Picking a preset clears
 * both custom bounds so the two cannot disagree; applying a custom range clears `range` so the preset
 * strip stops claiming a bound that no longer applies.
 */
export function StatisticsNav({
	tab,
	params,
	agents,
	devices,
}: {
	tab: TabId;
	params: Record<string, string | undefined>;
	agents: readonly Entity[];
	devices: readonly (Entity & { agentId: string })[];
}) {
	const router = useRouter();
	const fieldId = useId();

	const go = (updates: Record<string, string | null>): void => {
		const next = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) {
				next.set(key, value);
			}
		}
		for (const [key, value] of Object.entries(updates)) {
			if (value === null) {
				next.delete(key);
			} else {
				next.set(key, value);
			}
		}
		const query = next.toString();
		router.push(query ? `?${query}` : "?");
	};

	const activePreset = isRangePreset(params.range) ? params.range : undefined;
	// A device belongs to one agent, so once an agent is chosen, offering another agent's printers
	// is offering a filter combination the query beneath it would just return nothing for.
	const availableDevices = params.agent ? devices.filter((device) => device.agentId === params.agent) : devices;

	return (
		<div className="flex flex-col gap-3">
			<Tabs value={tab} onValueChange={(next) => go({ tab: String(next) })}>
				<TabsList variant="line">
					{TABS.map((id) => (
						<TabsTrigger key={id} value={id}>
							{TAB_LABELS[id]}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>

			<div className="flex flex-wrap items-end gap-2">
				<div className="flex flex-col gap-1">
					<span className={LABEL}>Range</span>
					<div className="flex items-center gap-2">
						<ToggleGroup
							size="sm"
							variant="outline"
							spacing={0}
							aria-label="Range preset"
							value={activePreset ? [activePreset] : []}
							onValueChange={(next) => {
								// Base UI's single-select toggle group still fires with an empty array when the
								// pressed item is clicked again — see the identical guard on the Settings boolean
								// control. Ignored here for the same reason: one of the five presets, or the
								// custom range beside them, is always in effect, and none pressed is not a state
								// this control can leave the URL in.
								const picked = next[0];
								if (picked !== undefined) {
									go({ range: picked, from: null, to: null });
								}
							}}
						>
							{RANGE_PRESETS.map((preset) => (
								<ToggleGroupItem key={preset} value={preset} className="text-[12px]">
									{preset}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
						<CustomRangePopover
							from={params.from}
							to={params.to}
							active={activePreset === undefined && Boolean(params.from) && Boolean(params.to)}
							onApply={(from, to) => go({ from, to, range: null })}
						/>
					</div>
				</div>

				<div className="flex flex-col gap-1">
					<span className={LABEL}>Agent</span>
					<EntityCombobox
						id={`${fieldId}-agent`}
						items={agents}
						value={params.agent}
						placeholder="Any agent"
						onChange={(id) => go({ agent: id ?? null, device: null })}
					/>
				</div>

				<div className="flex flex-col gap-1">
					<span className={LABEL}>Printer</span>
					<EntityCombobox
						id={`${fieldId}-device`}
						items={availableDevices}
						value={params.device}
						placeholder="Any printer"
						onChange={(id) => go({ device: id ?? null })}
					/>
				</div>
			</div>
		</div>
	);
}

/** The custom-range control: a trigger reading the active range, and two date fields in a popover. */
function CustomRangePopover({
	from,
	to,
	active,
	onApply,
}: {
	from: string | undefined;
	to: string | undefined;
	active: boolean;
	onApply: (from: string, to: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [draftFrom, setDraftFrom] = useState(from ?? "");
	const [draftTo, setDraftTo] = useState(to ?? "");

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// Re-seed the drafts from the URL every time the popover opens, so a previous edit that was
				// never applied does not reappear the next time it is opened.
				if (next) {
					setDraftFrom(from ?? "");
					setDraftTo(to ?? "");
				}
			}}
		>
			<PopoverTrigger
				aria-label="Custom range"
				render={<Button type="button" variant="outline" size="sm" />}
				className={cn("text-[12px]", active && "border-ring")}
			>
				{active && from && to ? `${formatDate(from)} – ${formatDate(to)}` : "Custom"}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-auto">
				<div className="flex items-end gap-2">
					<div className="flex flex-col gap-1">
						<span className={LABEL}>From</span>
						<DatePicker
							label="From date"
							value={draftFrom}
							onChange={setDraftFrom}
							className="h-8 w-[150px] text-[12px]"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className={LABEL}>To</span>
						<DatePicker label="To date" value={draftTo} onChange={setDraftTo} className="h-8 w-[150px] text-[12px]" />
					</div>
				</div>
				<div className="mt-2 flex justify-end">
					<Button
						type="button"
						size="sm"
						disabled={!draftFrom || !draftTo}
						onClick={() => {
							onApply(draftFrom, draftTo);
							setOpen(false);
						}}
					>
						Apply
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** One agent or device picked from a searchable list, clearable back to "every one". */
function EntityCombobox({
	id,
	items,
	value,
	placeholder,
	onChange,
}: {
	id: string;
	items: readonly Entity[];
	value: string | undefined;
	placeholder: string;
	onChange: (id: string | undefined) => void;
}) {
	const options = items.map((item) => ({ value: item.id, label: item.name }));
	const selected = options.find((option) => option.value === value) ?? null;

	return (
		<Combobox
			items={options}
			value={selected}
			onValueChange={(next) => onChange(next === null ? undefined : next.value)}
		>
			<ComboboxInput id={id} placeholder={placeholder} showClear className="h-8 w-[170px] text-[12px]" />
			<ComboboxContent>
				<ComboboxEmpty>No match.</ComboboxEmpty>
				<ComboboxList>
					{(option: { value: string; label: string }) => (
						<ComboboxItem key={option.value} value={option}>
							{option.label}
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}
