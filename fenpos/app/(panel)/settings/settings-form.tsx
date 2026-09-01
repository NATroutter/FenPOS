"use client";

import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import type { SettingChange } from "@/app/(panel)/settings/actions";
import { saveSettings } from "@/app/(panel)/settings/actions";
import { DirtyDot } from "@/components/panel/dirty-dot";
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

/** A setting's stored value, or the built-in default when nothing is stored. */
type SettingValue = SettingFieldData["value"];

/**
 * An edit made but not yet saved.
 *
 * A reset is its own kind rather than "set it to the fallback", because the two produce different
 * stored states: storing the fallback pins the value forever, while clearing the row means "use
 * whatever this version's default is". Collapsing them would quietly opt an install out of every
 * future improvement to that default.
 */
type Draft = { kind: "set"; value: SettingValue } | { kind: "reset" };

/** {@link SettingFieldData} narrowed to the integer variant. */
type IntegerField = SettingFieldData & { definition: Extract<ClientSettingDefinition, { type: "integer" }> };

/** {@link SettingFieldData} narrowed to the boolean variant. */
type BooleanField = SettingFieldData & { definition: Extract<ClientSettingDefinition, { type: "boolean" }> };

/** {@link SettingFieldData} narrowed to the enum variant. */
type EnumField = SettingFieldData & { definition: Extract<ClientSettingDefinition, { type: "enum" }> };

/** {@link SettingFieldData} narrowed to the string variant. */
type StringField = SettingFieldData & { definition: Extract<ClientSettingDefinition, { type: "string" }> };

/** What a control needs to render itself and stage an edit. */
interface ControlProps<Field extends SettingFieldData> {
	field: Field;
	/** The value to display: the staged edit if there is one, otherwise what the server holds. */
	value: SettingValue;
	/** Whether a save is in flight, during which no control accepts input. */
	saving: boolean;
	/** Stages an edit. Passing a value equal to the current stored state clears the draft instead. */
	onStage: (draft: Draft) => void;
}

/**
 * Whether a draft would change anything, given what the server currently holds.
 *
 * Typing a value back to what is already stored is not an edit, and neither is resetting a setting
 * that is already at its default. Without this the save bar counts changes that would write
 * nothing, which is worse than not counting at all — it asks for a decision about work that does
 * not exist.
 *
 * @param field the setting as the server holds it
 * @param draft the staged edit
 * @returns whether the draft differs from the stored state
 */
function changesAnything(field: SettingFieldData, draft: Draft): boolean {
	if (draft.kind === "reset") {
		return field.overridden;
	}
	return !field.overridden || draft.value !== field.value;
}

/**
 * The value a field should display, and whether it currently reads as overridden.
 *
 * Both follow the draft when there is one, so the footer's "default" marker and its reset link
 * describe the state the operator is looking at rather than the state on the server.
 *
 * @param field the setting as the server holds it
 * @param draft the staged edit, if any
 * @returns the value to show and whether to present it as overridden
 */
function effective(field: SettingFieldData, draft: Draft | undefined): { value: SettingValue; overridden: boolean } {
	if (!draft) {
		return { value: field.value, overridden: field.overridden };
	}
	if (draft.kind === "reset") {
		return { value: field.definition.fallback, overridden: false };
	}
	return { value: draft.value, overridden: true };
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
 * **Edits are staged, not saved as they are made.** Every control writes into `drafts` and nothing
 * reaches the server until Save is pressed. This is why the drafts live here rather than in each
 * control: a bar that says how many changes are outstanding, and a Discard that drops all of them,
 * can only exist somewhere that can see every field at once. It also means a change in a category
 * you are not looking at is still counted and still saved — which is what the marker on the rail is
 * for, since otherwise the bar would claim three changes over a category that looks untouched.
 */
export function SettingsForm({
	categories,
	settings,
}: {
	categories: readonly { id: SettingCategory; title: string; summary: string }[];
	settings: SettingFieldData[];
}) {
	const [selected, setSelected] = useState<SettingCategory>(categories[0]?.id ?? "limits");
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [saving, startSaving] = useTransition();

	const category = categories.find((entry) => entry.id === selected) ?? categories[0];
	const fields = settings.filter((setting) => setting.definition.category === selected);
	const pendingKeys = Object.keys(drafts);

	const stage = (field: SettingFieldData, draft: Draft): void => {
		setDrafts((previous) => {
			const next = { ...previous };
			if (changesAnything(field, draft)) {
				next[field.definition.key] = draft;
			} else {
				delete next[field.definition.key];
			}
			return next;
		});
		// An edit is an answer to whatever the server said last time. Keeping the old message under a
		// field the operator has just changed would attach a complaint to a value it was never about.
		setErrors((previous) => {
			if (!(field.definition.key in previous)) {
				return previous;
			}
			const next = { ...previous };
			delete next[field.definition.key];
			return next;
		});
	};

	const discard = (): void => {
		setDrafts({});
		setErrors({});
	};

	const save = (): void => {
		const changes: SettingChange[] = pendingKeys.map((key) => {
			const draft = drafts[key];
			return draft.kind === "reset" ? { key, kind: "reset" } : { key, kind: "set", value: draft.value };
		});

		startSaving(async () => {
			const { errors: failed } = await saveSettings(changes);
			const failedKeys = Object.keys(failed);

			// Only the refused settings stay staged. Clearing the whole batch would throw away edits
			// the server accepted nothing about, and keeping the whole batch would ask the operator to
			// re-confirm work that already landed.
			setDrafts((previous) => Object.fromEntries(failedKeys.map((key) => [key, previous[key]])));
			setErrors(failed);

			const saved = changes.length - failedKeys.length;
			if (failedKeys.length === 0) {
				toast.success(saved === 1 ? "1 setting saved." : `${saved} settings saved.`);
			} else if (saved === 0) {
				toast.error(failedKeys.length === 1 ? "That setting was refused." : "Those settings were refused.");
			} else {
				toast.warning(`${saved} saved, ${failedKeys.length} refused.`);
			}
		});
	};

	return (
		<div className="flex flex-col">
			<Card className="overflow-hidden p-0">
				<div className="grid sm:grid-cols-[170px_1fr]">
					{/* The rail. A row of tabs would run out of width at eight categories and wrap, and a
					    wrapped tab row reads as two rows of unrelated things. */}
					<nav className="flex gap-1 overflow-x-auto border-b p-2 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0">
						{categories.map((entry) => {
							const dirty = settings.some(
								(setting) => setting.definition.category === entry.id && setting.definition.key in drafts,
							);

							return (
								<button
									key={entry.id}
									type="button"
									onClick={() => setSelected(entry.id)}
									data-active={entry.id === selected || undefined}
									className={cn(
										"flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-left text-[13px] text-muted-foreground",
										"hover:bg-accent hover:text-foreground",
										"data-active:bg-accent data-active:font-medium data-active:text-foreground",
									)}
								>
									<span className="min-w-0 flex-1 truncate">{entry.title}</span>
									{dirty ? <DirtyDot /> : null}
								</button>
							);
						})}
					</nav>

					<div className="min-w-0 p-5">
						<h3 className="text-[13px] font-medium">{category?.title}</h3>
						<p className="mt-0.5 text-[11.5px] text-muted-foreground">{category?.summary}</p>

						<div className="mt-5 grid gap-x-6 gap-y-6 lg:grid-cols-2 2xl:grid-cols-3">
							{fields.map((setting) => (
								<SettingField
									key={setting.definition.key}
									field={setting}
									draft={drafts[setting.definition.key]}
									error={errors[setting.definition.key]}
									saving={saving}
									onStage={(draft) => stage(setting, draft)}
								/>
							))}
						</div>
					</div>
				</div>
			</Card>

			<SaveBar count={pendingKeys.length} saving={saving} onDiscard={discard} onSave={save} />
		</div>
	);
}

/**
 * The bar that appears once anything is staged.
 *
 * Sticky rather than fixed: fixed would sit over the sidebar at narrow widths, and sticky keeps it
 * inside the column it belongs to while still floating above the content as the page scrolls. It
 * renders nothing at all when there is nothing to save, so a settled page carries no chrome for a
 * decision nobody has to make.
 *
 * @param count how many settings are staged
 * @param saving whether a save is in flight
 * @param onDiscard drops every staged change
 * @param onSave commits every staged change
 */
function SaveBar({
	count,
	saving,
	onDiscard,
	onSave,
}: {
	count: number;
	saving: boolean;
	onDiscard: () => void;
	onSave: () => void;
}) {
	if (count === 0) {
		return null;
	}

	return (
		<div className="pointer-events-none sticky bottom-4 z-20 mt-4 flex justify-end">
			<div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-popover/95 py-2 pr-2 pl-4 shadow-lg backdrop-blur-sm">
				<span className="text-[12.5px] text-muted-foreground">
					{count === 1 ? "1 unsaved change" : `${count} unsaved changes`}
				</span>
				<Button variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>
					Discard
				</Button>
				<Button size="sm" disabled={saving} onClick={onSave}>
					{saving ? <Spinner className="size-3.5" /> : null}
					Save changes
				</Button>
			</div>
		</div>
	);
}

/**
 * One setting: its label, its key, the control for its variant, and the shared footer.
 *
 * The dirty marker sits after the label rather than before it, so the labels stay left-aligned with
 * each other whether or not they are dirty — a marker in front indents the word it marks, and a
 * column of labels that shift sideways as you edit them is harder to scan than one that does not.
 */
function SettingField({
	field,
	draft,
	error,
	saving,
	onStage,
}: {
	field: SettingFieldData;
	draft: Draft | undefined;
	error: string | undefined;
	saving: boolean;
	onStage: (draft: Draft) => void;
}) {
	const { value, overridden } = effective(field, draft);

	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="truncate text-[12.5px] font-medium">{field.definition.label}</span>
					{draft ? <DirtyDot /> : null}
				</div>
				<div className="mt-0.5 truncate font-mono text-[11px] text-subtle-foreground">{field.definition.key}</div>
			</div>

			<Control field={field} value={value} saving={saving} onStage={onStage} />

			<FieldFooter field={field} overridden={overridden} error={error} saving={saving} onStage={onStage} />
		</div>
	);
}

/**
 * Delegates to the one control that matches `field.definition.type`.
 *
 * TypeScript narrows `field.definition` when this switches on its `type`, but that narrowing does
 * not reshape `field` itself into the matching `*Field` type — the discriminant is nested one
 * property down, not on `field` directly. The `as` below is safe precisely because the `case`
 * already checked it.
 */
function Control({ field, value, saving, onStage }: ControlProps<SettingFieldData>) {
	switch (field.definition.type) {
		case "integer":
			return <IntegerControl field={field as IntegerField} value={value} saving={saving} onStage={onStage} />;
		case "boolean":
			return <BooleanControl value={value} saving={saving} onStage={onStage} />;
		case "enum":
			return <EnumControl field={field as EnumField} value={value} saving={saving} onStage={onStage} />;
		case "string":
			return <StringControl field={field as StringField} value={value} saving={saving} onStage={onStage} />;
	}
}

/**
 * Past this many values, an enum's bounds line names the count rather than listing every member.
 *
 * Every enum this project shipped before `panel.timezone` fits comfortably under this with room to
 * spare (`logs.minimumLevel`'s four severities is the longest) — `panel.timezone`'s ~400 IANA zones
 * is the outlier that made a fixed threshold necessary at all. The dropdown itself still lists every
 * value; this line is a one-glance summary, not the only way to see the options.
 */
const ENUM_BOUNDS_LIST_LIMIT = 8;

/**
 * The bounds line under a setting's description: what a value must satisfy, phrased for reading
 * rather than for validation. `null` for a boolean, which has no bounds beyond on/off.
 *
 * An enum lists its values only up to {@link ENUM_BOUNDS_LIST_LIMIT} — past that, `values.join(", ")`
 * stops being a summary and becomes the whole page's worth of text `panel.timezone` produced, with
 * its own reset link pushed to the far end of it. Named by count instead, whatever setting causes it.
 */
function bounds(definition: ClientSettingDefinition): ReactNode {
	switch (definition.type) {
		case "integer":
			return `${definition.unit}, ${definition.min}–${definition.max}`;
		case "enum":
			return definition.values.length > ENUM_BOUNDS_LIST_LIMIT
				? `one of ${definition.values.length} options`
				: definition.values.join(", ");
		case "string":
			return `at most ${definition.maxLength} characters`;
		case "boolean":
			return null;
	}
}

/**
 * The description, bounds line, reset link and refusal message shared by every control.
 *
 * Reset stages a change like any other edit rather than saving on the spot. A form where one
 * control commits immediately and the rest wait for a button is a form where somebody eventually
 * loses an edit they thought was safe.
 *
 * @param field the setting this footer describes
 * @param overridden whether the setting currently reads as overridden, following any staged draft
 * @param error the server's refusal message for this setting, from the last save
 * @param saving whether a save is in flight
 * @param onStage stages the reset
 */
function FieldFooter({
	field,
	overridden,
	error,
	saving,
	onStage,
}: {
	field: SettingFieldData;
	overridden: boolean;
	error: string | undefined;
	saving: boolean;
	onStage: (draft: Draft) => void;
}) {
	const { definition } = field;
	const line = bounds(definition);
	// `String(...)` rather than a template literal directly on `definition.fallback`, so a `boolean`
	// fallback stringifies to "true"/"false" instead of being coerced some other way. Empty is a real
	// fallback too — `server.publicUrl`'s is `""` — and "Reset to " with nothing after it is a worse
	// label than the setting-agnostic "Reset" this falls back to.
	const fallbackLabel = String(definition.fallback);

	return (
		<>
			<p className="text-[11.5px] leading-relaxed text-muted-foreground">
				{definition.description}
				{line ? (
					<>
						{" "}
						<span className="text-subtle-foreground">{line}</span>
					</>
				) : null}
				{overridden ? (
					<>
						{" · "}
						<Button
							variant="link"
							className="h-auto p-0 text-[11.5px] font-normal"
							disabled={saving}
							onClick={() => onStage({ kind: "reset" })}
						>
							<RotateCcw className="size-3" />
							{fallbackLabel ? `Reset to ${fallbackLabel}` : "Reset"}
						</Button>
					</>
				) : (
					<span className="text-subtle-foreground"> · default</span>
				)}
			</p>

			{error ? <p className="text-[11.5px] leading-relaxed text-destructive">{error}</p> : null}
		</>
	);
}

/**
 * Keeps a control's own editable copy in step with the value it is given.
 *
 * The number and text controls cannot be purely controlled: both hold states the draft never
 * should — a cleared number box is `null`, and half-typed text is not a value anyone wants staged
 * as it is typed. So each keeps its own copy and stages on a settled value. This re-syncs that copy
 * whenever the value behind it moves for a reason the control did not cause: a discard, a
 * successful save, or a reset staged from the footer.
 *
 * @param value the value the control should be showing
 * @returns the editable copy and its setter
 */
function useEditableCopy<T>(value: T): [T, (next: T) => void] {
	const [copy, setCopy] = useState<T>(value);

	useEffect(() => {
		setCopy(value);
	}, [value]);

	return [copy, setCopy];
}

/**
 * A setting held as a whole number in a bounded range.
 *
 * Stages on every valid value rather than on blur. Waiting for blur was right while each edit was
 * a request — it kept a held-down stepper from firing one save per click — but a staged change
 * costs nothing, and blur never comes for the stepper buttons: clicking `+` and then Save dropped
 * the increment, because focus had gone straight from the button to the save bar without ever
 * leaving the field. Blur is left doing the one job it is still needed for, below.
 */
function IntegerControl({ field, value, saving, onStage }: ControlProps<IntegerField>) {
	const { definition } = field;
	const [draft, setDraft] = useEditableCopy<number | null>(value as number);

	return (
		<NumberField
			value={draft}
			min={definition.min}
			max={definition.max}
			disabled={saving}
			onValueChange={(next) => {
				setDraft(next);
				// A half-typed number is a real state of the box — `-` on its own, or an empty field
				// mid-retype — and none of those are values to stage. The box keeps showing them; the
				// draft only takes whole numbers.
				if (next !== null && Number.isInteger(next)) {
					onStage({ kind: "set", value: next });
				}
			}}
			onBlur={() => {
				// Leaving the field having emptied it, or with something that never became a number,
				// snaps the box back to what is actually staged. Otherwise it sits there blank, looking
				// like a value that will be saved.
				if (draft === null || !Number.isInteger(draft)) {
					setDraft(value as number);
				}
			}}
		>
			<NumberFieldGroup>
				<NumberFieldDecrement />
				<NumberFieldInput className="font-mono" />
				<NumberFieldIncrement />
			</NumberFieldGroup>
		</NumberField>
	);
}

/**
 * A setting that is on or off. Stages on change: a switch has no settled moment to wait for.
 *
 * Takes no `field`, unlike its siblings — a switch renders from the value alone, with nothing to
 * read off the definition.
 */
function BooleanControl({ value, saving, onStage }: Omit<ControlProps<BooleanField>, "field">) {
	return (
		<Switch
			checked={value as boolean}
			disabled={saving}
			onCheckedChange={(next: boolean) => onStage({ kind: "set", value: next })}
		/>
	);
}

/** A setting chosen from a fixed set. Stages on change, for the same reason. */
function EnumControl({ field, value, saving, onStage }: ControlProps<EnumField>) {
	return (
		<Select
			value={value as string}
			disabled={saving}
			onValueChange={(next) => {
				// Base UI's single-select allows `null` in the type to cover "nothing selected"; this
				// select always has an item selected, so only the non-null branch ever runs.
				if (next === null) {
					return;
				}
				onStage({ kind: "set", value: next });
			}}
		>
			{/* Full width, like the number and text controls beside it. A `w-fit` trigger sized itself to
			    whichever value happened to be selected, which put a 73px control in a 423px column next to
			    inputs that filled theirs. */}
			<SelectTrigger className="w-full font-mono">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{field.definition.values.map((option) => (
					<SelectItem key={option} value={option}>
						{option}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * A free-text setting.
 *
 * Stages as it is typed, like the number field, and for the same reason: staging is local, so
 * there is nothing to defer, and an edit that only counts once focus moves is an edit somebody can
 * lose by clicking straight at Save.
 */
function StringControl({ field, value, saving, onStage }: ControlProps<StringField>) {
	const [draft, setDraft] = useEditableCopy(value as string);

	return (
		<Input
			value={draft}
			disabled={saving}
			maxLength={field.definition.maxLength}
			className="font-mono"
			onChange={(event) => {
				setDraft(event.target.value);
				onStage({ kind: "set", value: event.target.value });
			}}
		/>
	);
}
