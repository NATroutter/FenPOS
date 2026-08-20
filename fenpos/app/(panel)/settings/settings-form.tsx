"use client";

import type { LucideIcon } from "lucide-react";
import { Gauge, ListOrdered, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { resetSetting, saveSetting } from "@/app/(panel)/settings/actions";
import {
	NumberField,
	NumberFieldDecrement,
	NumberFieldGroup,
	NumberFieldIncrement,
	NumberFieldInput,
} from "@/components/reui/number-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

/** One setting as the form holds it. */
export interface SettingFieldData {
	key: string;
	label: string;
	description: string;
	min: number;
	max: number;
	fallback: number;
	unit: string;
	value: number;
	overridden: boolean;
}

/**
 * What each group of settings is for.
 *
 * Keyed by the prefix the setting keys already carry, so a new setting joins the right group
 * by being named consistently rather than by being registered in a second place.
 */
const GROUPS: Record<string, { title: string; summary: string; icon: LucideIcon }> = {
	limits: {
		title: "Limits",
		summary: "Counted on the request as received, before markup is interpreted.",
		icon: Gauge,
	},
	jobs: {
		title: "Jobs",
		summary: "How much history is kept, and how long a shutdown waits.",
		icon: ListOrdered,
	},
};

/** Stands in for a group the table does not name, so an unknown prefix still renders a header. */
const FALLBACK_ICON: LucideIcon = SlidersHorizontal;

/**
 * The global settings form.
 *
 * Laid out as one card per group with the fields in a row, rather than a single column of
 * unrelated inputs. The keys are already namespaced — `limits.*`, `jobs.*` — and showing that
 * structure is what lets an operator find a setting by the part of the system it affects
 * instead of reading every label in order.
 *
 * Each field saves on its own. These are unrelated knobs, and one save button would make
 * changing any of them look like a commitment to whatever state the others happened to be in
 * on screen.
 */
export function SettingsForm({ settings }: { settings: SettingFieldData[] }) {
	const groups = new Map<string, SettingFieldData[]>();
	for (const setting of settings) {
		const prefix = setting.key.split(".")[0];
		const existing = groups.get(prefix);
		if (existing) {
			existing.push(setting);
		} else {
			groups.set(prefix, [setting]);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			{[...groups].map(([prefix, fields]) => {
				const group = GROUPS[prefix];
				const Icon = group?.icon ?? FALLBACK_ICON;

				return (
					<Card key={prefix}>
						{/* Flex rather than the header's default grid, so the icon centres against the
					    title and summary together instead of sitting on the title's line. Same shape
					    every other card's header uses. */}
						<CardHeader className="flex flex-row items-center gap-3">
							<Icon className="size-4.5 shrink-0 text-subtle-foreground" />
							<div className="min-w-0">
								<h3 className="text-[13px] font-medium">{group?.title ?? prefix}</h3>
								{/* The prefix used to lead this line. It is on every field below it in
							    `limits.maxLines` form, so repeating it here said nothing twice. */}
								<p className="mt-0.5 text-[11.5px] text-muted-foreground">{group?.summary ?? prefix}</p>
							</div>
						</CardHeader>

						<CardContent className="grid gap-x-6 gap-y-6 pt-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
							{fields.map((setting) => (
								<SettingField key={setting.key} setting={setting} />
							))}
						</CardContent>
					</Card>
				);
			})}
		</div>
	);
}

/** One setting, saved when the value settles. */
function SettingField({ setting }: { setting: SettingFieldData }) {
	const [value, setValue] = useState<number | null>(setting.value);
	const [pending, startTransition] = useTransition();

	const commit = (next: number | null): void => {
		// A cleared or unchanged field is not a change. Snapping back to the stored value beats
		// leaving an empty box that looks like it saved something.
		if (next === null || !Number.isInteger(next) || next === setting.value) {
			setValue(setting.value);
			return;
		}
		startTransition(async () => {
			const result = await saveSetting(setting.key, next);
			if (result.error) {
				toast.error(result.error);
				setValue(setting.value);
			} else {
				toast.success(`${setting.label} saved.`);
			}
		});
	};

	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="min-w-0">
				<div className="truncate text-[12.5px] font-medium">{setting.label}</div>
				<div className="mt-0.5 truncate font-mono text-[11px] text-subtle-foreground">{setting.key}</div>
			</div>

			<NumberField
				value={value}
				min={setting.min}
				max={setting.max}
				disabled={pending}
				onValueChange={setValue}
				onBlur={() => commit(value)}
			>
				<NumberFieldGroup>
					<NumberFieldDecrement />
					<NumberFieldInput className="font-mono" />
					<NumberFieldIncrement />
				</NumberFieldGroup>
			</NumberField>

			<p className="text-[11.5px] leading-relaxed text-muted-foreground">
				{setting.description}{" "}
				<span className="text-subtle-foreground">
					{setting.unit}, {setting.min}–{setting.max}
				</span>
				{setting.overridden ? (
					<>
						{" · "}
						<Button
							variant="link"
							className="h-auto p-0 text-[11.5px] font-normal"
							disabled={pending}
							onClick={() =>
								startTransition(async () => {
									const result = await resetSetting(setting.key);
									if (result.error) {
										toast.error(result.error);
									} else {
										setValue(setting.fallback);
										toast.success(`${setting.label} reset to its default.`);
									}
								})
							}
						>
							{pending ? <Spinner className="size-3" /> : <RotateCcw className="size-3" />}
							Reset to {setting.fallback}
						</Button>
					</>
				) : (
					<span className="text-subtle-foreground"> · default</span>
				)}
			</p>
		</div>
	);
}
