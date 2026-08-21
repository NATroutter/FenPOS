"use client";

import { RotateCcw } from "lucide-react";
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
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
// Type-only: `settings-service` starts with `import "server-only"`, so a value import here would
// pull that guard into this client component's bundle. The category list itself is computed in
// the (server) page and passed down as a prop instead.
import type { SettingCategory, SettingDefinition } from "@/lib/settings/settings-service";
import { cn } from "@/lib/utils";

/** One setting as the form holds it. */
export interface SettingFieldData {
	definition: SettingDefinition;
	value: number | string | boolean;
	overridden: boolean;
}

/**
 * The install-wide settings form.
 *
 * A category at a time, chosen from the rail on the left. Stacked cards were right for seven
 * settings and stop being right well before forty: a page you scroll past nine cards to reach the
 * tenth is one where the way to find a setting is ctrl-F, and a settings page whose navigation is
 * the browser's is not navigable.
 *
 * The category is held in state and is neither routed nor persisted, the same choice the profile
 * dialog makes: a settings category is not a place you link someone to.
 *
 * Each field saves on its own. These are unrelated knobs, and one save button across all of them
 * would make changing any one look like a commitment to whatever state the others happened to be
 * in on screen.
 */
export function SettingsForm({
	categories,
	settings,
}: {
	categories: readonly { id: SettingCategory; title: string; summary: string }[];
	settings: SettingFieldData[];
}) {
	const [selected, setSelected] = useState<SettingCategory>(categories[0]?.id ?? "limits");
	const category = categories.find((entry) => entry.id === selected) ?? categories[0];
	const fields = settings.filter((setting) => setting.definition.category === selected);

	return (
		<Card className="overflow-hidden p-0">
			<div className="grid sm:grid-cols-[170px_1fr]">
				{/* The rail. A row of tabs would run out of width at eight categories and wrap, and a
				    wrapped tab row reads as two rows of unrelated things. */}
				<nav className="flex gap-1 overflow-x-auto border-b p-2 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0">
					{categories.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setSelected(entry.id)}
							data-active={entry.id === selected || undefined}
							className={cn(
								"shrink-0 rounded-md px-3 py-2 text-left text-[13px] text-muted-foreground",
								"hover:bg-accent hover:text-foreground",
								"data-active:bg-accent data-active:font-medium data-active:text-foreground",
							)}
						>
							{entry.title}
						</button>
					))}
				</nav>

				<div className="min-w-0 p-5">
					<h3 className="text-[13px] font-medium">{category?.title}</h3>
					<p className="mt-0.5 text-[11.5px] text-muted-foreground">{category?.summary}</p>

					<div className="mt-5 grid gap-x-6 gap-y-6 lg:grid-cols-2 2xl:grid-cols-3">
						{fields.map((setting) => (
							<SettingField key={setting.definition.key} setting={setting} />
						))}
					</div>
				</div>
			</div>
		</Card>
	);
}

/**
 * One setting, saved when the value settles.
 *
 * Only the integer variant has a control today — Task 8 fills in the other three. Narrowing on
 * `definition.type` here rather than filtering in the page means an unsupported setting still
 * gets a slot in the grid; it simply renders nothing into it until its control exists.
 */
function SettingField({ setting }: { setting: SettingFieldData }) {
	const { definition } = setting;
	const [value, setValue] = useState<number | null>(typeof setting.value === "number" ? setting.value : null);
	const [pending, startTransition] = useTransition();

	if (definition.type !== "integer") {
		return null;
	}

	const commit = (next: number | null): void => {
		// A cleared or unchanged field is not a change. Snapping back to the stored value beats
		// leaving an empty box that looks like it saved something.
		if (next === null || !Number.isInteger(next) || next === setting.value) {
			setValue(setting.value as number);
			return;
		}
		startTransition(async () => {
			const result = await saveSetting(definition.key, next);
			if (result.error) {
				toast.error(result.error);
				setValue(setting.value as number);
			} else {
				toast.success(`${definition.label} saved.`);
			}
		});
	};

	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="min-w-0">
				<div className="truncate text-[12.5px] font-medium">{definition.label}</div>
				<div className="mt-0.5 truncate font-mono text-[11px] text-subtle-foreground">{definition.key}</div>
			</div>

			<NumberField
				value={value}
				min={definition.min}
				max={definition.max}
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
				{definition.description}{" "}
				<span className="text-subtle-foreground">
					{definition.unit}, {definition.min}–{definition.max}
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
									const result = await resetSetting(definition.key);
									if (result.error) {
										toast.error(result.error);
									} else {
										setValue(definition.fallback);
										toast.success(`${definition.label} reset to its default.`);
									}
								})
							}
						>
							{pending ? <Spinner className="size-3" /> : <RotateCcw className="size-3" />}
							Reset to {definition.fallback}
						</Button>
					</>
				) : (
					<span className="text-subtle-foreground"> · default</span>
				)}
			</p>
		</div>
	);
}
