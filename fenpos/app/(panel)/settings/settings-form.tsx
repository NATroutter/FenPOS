"use client";

import { RotateCcw } from "lucide-react";
import type { ReactNode, TransitionStartFunction } from "react";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
// Type-only: `settings-service` starts with `import "server-only"`, so a value import here would
// pull that guard into this client component's bundle. The category list itself is computed in
// the (server) page and passed down as a prop instead.
import type { ClientSettingDefinition, SettingCategory } from "@/lib/settings/settings-service";
import { cn } from "@/lib/utils";

/**
 * One setting as the form holds it.
 *
 * `definition` is a {@link ClientSettingDefinition}, not the full `SettingDefinition` — the server
 * page strips `pattern` before this ever reaches the client, because a `RegExp` cannot cross that
 * boundary. See `ClientSettingDefinition`'s doc comment for why.
 */
export interface SettingFieldData {
	definition: ClientSettingDefinition;
	value: number | string | boolean;
	overridden: boolean;
}

/** {@link SettingFieldData} narrowed to the integer variant. */
type IntegerField = SettingFieldData & { definition: Extract<ClientSettingDefinition, { type: "integer" }> };

/** {@link SettingFieldData} narrowed to the boolean variant. */
type BooleanField = SettingFieldData & { definition: Extract<ClientSettingDefinition, { type: "boolean" }> };

/** {@link SettingFieldData} narrowed to the enum variant. */
type EnumField = SettingFieldData & { definition: Extract<ClientSettingDefinition, { type: "enum" }> };

/** {@link SettingFieldData} narrowed to the string variant. */
type StringField = SettingFieldData & { definition: Extract<ClientSettingDefinition, { type: "string" }> };

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
 * One setting: its label and key, the control for its variant, and the shared footer.
 *
 * Narrows on `definition.type` in {@link Control} rather than filtering in the page, so adding a
 * fifth variant is a matter of adding a case there, not touching the page or this component.
 */
function SettingField({ setting }: { setting: SettingFieldData }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="min-w-0">
				<div className="truncate text-[12.5px] font-medium">{setting.definition.label}</div>
				<div className="mt-0.5 truncate font-mono text-[11px] text-subtle-foreground">{setting.definition.key}</div>
			</div>

			<Control setting={setting} />
		</div>
	);
}

/**
 * Delegates to the one control that matches `setting.definition.type`.
 *
 * TypeScript narrows `setting.definition` when this switches on its `type`, but that narrowing
 * does not reshape `setting` itself into the matching `*Field` type — the discriminant is nested
 * one property down, not on `setting` directly. The `as` below is safe precisely because the
 * `case` already checked it.
 */
function Control({ setting }: { setting: SettingFieldData }) {
	switch (setting.definition.type) {
		case "integer":
			return <IntegerControl setting={setting as IntegerField} />;
		case "boolean":
			return <BooleanControl setting={setting as BooleanField} />;
		case "enum":
			return <EnumControl setting={setting as EnumField} />;
		case "string":
			return <StringControl setting={setting as StringField} />;
	}
}

/**
 * Saves a setting, reverting the control when the server refuses it.
 *
 * Shared by all four controls because the failure path is the interesting part and it is identical
 * for each: the server is the only thing that knows whether a value is acceptable, so a rejected
 * value has to be taken back off the screen.
 *
 * @param setting the field being saved
 * @param next the value to store
 * @param revert puts the control back to the stored value
 */
async function commitValue(setting: SettingFieldData, next: unknown, revert: () => void): Promise<void> {
	const result = await saveSetting(setting.definition.key, next);
	if (result.error) {
		toast.error(result.error);
		revert();
	} else {
		toast.success(`${setting.definition.label} saved.`);
	}
}

/**
 * The bounds line under a setting's description: what a value must satisfy, phrased for reading
 * rather than for validation. `null` for a boolean, which has no bounds beyond on/off.
 */
function bounds(definition: ClientSettingDefinition): ReactNode {
	switch (definition.type) {
		case "integer":
			return `${definition.unit}, ${definition.min}–${definition.max}`;
		case "enum":
			return definition.values.join(", ");
		case "string":
			return `at most ${definition.maxLength} characters`;
		case "boolean":
			return null;
	}
}

/**
 * The description, bounds line, and reset link shared by every control.
 *
 * Not the source of truth for the control's displayed value — each control owns that itself, since
 * a number and a switch and free text are not the same state shape. `onReset` is how this footer
 * hands a successful reset back to the control that needs to show it: the server row is gone, but
 * only the control holds the piece of state that has to snap to the fallback on screen.
 *
 * `startTransition` is the control's own, passed in rather than owned here, so a save and a reset
 * for the same setting share one `pending` flag instead of two independent ones. Before this
 * split, a single `useTransition` covered both actions in one component, which kept the input
 * disabled for the duration of either; giving the reset link its own transition would reopen the
 * input mid-reset, letting someone type over a value that is about to be overwritten anyway.
 *
 * @param setting the field this footer describes
 * @param pending whether the control has a save or a reset in flight, since both run through the
 *   same `startTransition` — used to disable the reset link and to swap its icon for a spinner
 * @param startTransition the control's own transition starter, shared with its save path
 * @param onReset called with the fallback value once the server confirms the reset
 */
function FieldFooter({
	setting,
	pending,
	startTransition,
	onReset,
}: {
	setting: SettingFieldData;
	pending: boolean;
	startTransition: TransitionStartFunction;
	onReset: (fallback: SettingFieldData["value"]) => void;
}) {
	const { definition } = setting;
	const line = bounds(definition);
	// `String(...)` rather than a template literal directly on `definition.fallback`, so a
	// `boolean` fallback stringifies to "true"/"false" instead of being coerced some other way.
	// Empty is a real fallback too — `server.publicUrl`'s is `""` — and "Reset to " with nothing
	// after it is a worse label than the setting-agnostic "Reset" this falls back to.
	const fallbackLabel = String(definition.fallback);

	return (
		<p className="text-[11.5px] leading-relaxed text-muted-foreground">
			{definition.description}
			{line ? (
				<>
					{" "}
					<span className="text-subtle-foreground">{line}</span>
				</>
			) : null}
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
									onReset(definition.fallback);
									toast.success(`${definition.label} reset to its default.`);
								}
							})
						}
					>
						{pending ? <Spinner className="size-3" /> : <RotateCcw className="size-3" />}
						{fallbackLabel ? `Reset to ${fallbackLabel}` : "Reset"}
					</Button>
				</>
			) : (
				<span className="text-subtle-foreground"> · default</span>
			)}
		</p>
	);
}

/** A setting held as a whole number in a bounded range. Saves on blur, like the string field. */
function IntegerControl({ setting }: { setting: IntegerField }) {
	const { definition } = setting;
	const [value, setValue] = useState<number | null>(typeof setting.value === "number" ? setting.value : null);
	const [pending, startTransition] = useTransition();

	const commit = (next: number | null): void => {
		// A cleared or unchanged field is not a change. Snapping back to the stored value beats
		// leaving an empty box that looks like it saved something.
		if (next === null || !Number.isInteger(next) || next === setting.value) {
			setValue(setting.value as number);
			return;
		}
		startTransition(() => commitValue(setting, next, () => setValue(setting.value as number)));
	};

	return (
		<>
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

			<FieldFooter
				setting={setting}
				pending={pending}
				startTransition={startTransition}
				onReset={(fallback) => setValue(fallback as number)}
			/>
		</>
	);
}

/** A setting that is on or off. Saves on change: a switch has no settled moment to wait for. */
function BooleanControl({ setting }: { setting: BooleanField }) {
	const [value, setValue] = useState(setting.value as boolean);
	const [pending, startTransition] = useTransition();

	return (
		<>
			<Switch
				checked={value}
				disabled={pending}
				onCheckedChange={(next: boolean) => {
					setValue(next);
					startTransition(() => commitValue(setting, next, () => setValue(setting.value as boolean)));
				}}
			/>

			<FieldFooter
				setting={setting}
				pending={pending}
				startTransition={startTransition}
				onReset={(fallback) => setValue(fallback as boolean)}
			/>
		</>
	);
}

/** A setting chosen from a fixed set. Saves on change, for the same reason. */
function EnumControl({ setting }: { setting: EnumField }) {
	const [value, setValue] = useState(setting.value as string);
	const [pending, startTransition] = useTransition();

	return (
		<>
			<Select
				value={value}
				disabled={pending}
				onValueChange={(next) => {
					// Base UI's single-select allows `null` in the type to cover "nothing selected";
					// this select always has an item selected, so only the non-null branch ever runs.
					if (next === null) {
						return;
					}
					setValue(next);
					startTransition(() => commitValue(setting, next, () => setValue(setting.value as string)));
				}}
			>
				<SelectTrigger className="font-mono">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{setting.definition.values.map((option) => (
						<SelectItem key={option} value={option}>
							{option}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<FieldFooter
				setting={setting}
				pending={pending}
				startTransition={startTransition}
				onReset={(fallback) => setValue(fallback as string)}
			/>
		</>
	);
}

/** A free-text setting. Saves on blur, like the number field. */
function StringControl({ setting }: { setting: StringField }) {
	const [value, setValue] = useState(setting.value as string);
	const [pending, startTransition] = useTransition();

	return (
		<>
			<Input
				value={value}
				disabled={pending}
				maxLength={setting.definition.maxLength}
				className="font-mono"
				onChange={(event) => setValue(event.target.value)}
				onBlur={() => {
					if (value === setting.value) {
						return;
					}
					startTransition(() => commitValue(setting, value, () => setValue(setting.value as string)));
				}}
			/>

			<FieldFooter
				setting={setting}
				pending={pending}
				startTransition={startTransition}
				onReset={(fallback) => setValue(fallback as string)}
			/>
		</>
	);
}
