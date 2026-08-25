"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { type ReactElement, useEffect, useState, useTransition } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { previewMoment, saveVariable } from "@/app/(panel)/variables/actions";
import { CONTEXT_LABELS, KIND_LABELS } from "@/app/(panel)/variables/variable-row";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	ContextSource,
	OffsetUnit,
	type VariableDefinition,
	VariableKind,
	variableDefinitionSchema,
} from "@/lib/variables/definition";

/**
 * Pattern presets for a `DATETIME` variable, offered as one-click buttons beside the field.
 *
 * `cccc`, not `EEEE`, for the bare day name. `date-fns` renders `EEEE` as the "formatting" form,
 * which several locales inflect for use inside a sentence — Finnish gives "keskiviikkona" ("on
 * Wednesday") where `cccc`'s standalone form gives "keskiviikko". A receipt printing a bare day
 * name wants the standalone form; this was found the hard way while building the evaluator.
 */
const PATTERN_PRESETS = ["HH:mm", "HH:mm:ss", "dd.MM.yyyy", "dd.MM.yyyy HH:mm", "cccc", "yyyy-MM-dd"] as const;

/** How long to wait after the last keystroke before asking the server to render the preview. */
const PREVIEW_DEBOUNCE_MS = 300;

/** A blank definition, for creating rather than editing. */
const EMPTY_VARIABLE: VariableDefinition = {
	name: "",
	kind: "STATIC",
	value: "",
	pattern: null,
	offsetAmount: null,
	offsetUnit: null,
	source: null,
	overridable: false,
	description: null,
};

/**
 * Turns a definition into the shape the form holds.
 *
 * Only `description` needs the touch: it is the one nullable field left to a plain, uncontrolled
 * `register` rather than a `Controller`, and an uncontrolled text input given `null` as its initial
 * value is a React Hook Form footgun — the DOM element has no sensible "null" to display. Every
 * other nullable field (`value`, `pattern`, `offsetAmount`, `offsetUnit`, `source`) is driven by a
 * `Controller` in the JSX below, which coalesces `null` to a display default itself and needs no
 * help here.
 *
 * @param source the definition to edit, or undefined for a fresh one
 * @returns values safe to hand `useForm`'s `defaultValues` or `form.reset`
 */
function toFormValues(source: VariableDefinition | undefined): VariableDefinition {
	const base = source ?? EMPTY_VARIABLE;
	return { ...base, description: base.description ?? "" };
}

/**
 * Defines a new variable, or edits an existing one.
 *
 * **Switching kind wipes the fields that belonged to the old one, unconditionally.** The schema
 * refuses a `STATIC` row carrying a `pattern` and a `CONTEXT` row carrying a `value` — see
 * {@link changeKindTo} — so a form that tried to remember a value "just in case" the operator
 * switched back would be a form that could submit a shape the schema always refuses, leaving the
 * operator staring at a validation error that names a field they cannot see.
 */
export function VariableDialog({
	variableId,
	initial,
	trigger,
}: {
	variableId?: string;
	initial?: VariableDefinition;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();
	const [preview, setPreview] = useState<{ text: string | null; error: string | null }>({ text: null, error: null });

	const form = useForm<VariableDefinition>({
		resolver: zodResolver(variableDefinitionSchema),
		defaultValues: toFormValues(initial),
	});

	const kind = useWatch({ control: form.control, name: "kind" });
	const name = useWatch({ control: form.control, name: "name" });
	const pattern = useWatch({ control: form.control, name: "pattern" });
	const offsetAmount = useWatch({ control: form.control, name: "offsetAmount" });
	const offsetUnit = useWatch({ control: form.control, name: "offsetUnit" });

	/**
	 * Moves the form to a new kind, resetting every field that belongs to a kind rather than to the
	 * variable as a whole.
	 *
	 * Fresh defaults rather than nulls across the board: a `DATETIME` variable with no pattern or a
	 * `CONTEXT` variable with no source is not a useful starting point, so switching in seeds one
	 * that at least parses, leaving the operator free to change it rather than required to fill in
	 * every field from nothing.
	 */
	const changeKindTo = (next: VariableKind): void => {
		// Revalidated only once the operator has already tried to submit once: before that, an
		// empty `pattern` freshly seeded by switching into `DATETIME` would otherwise flash a raw
		// "too small" message the instant the kind changes, for a field nobody has had a chance to
		// type into yet.
		const revalidate = form.formState.isSubmitted;
		form.setValue("kind", next, { shouldValidate: revalidate });
		form.setValue("value", next === "STATIC" ? "" : null, { shouldValidate: revalidate });
		form.setValue("pattern", next === "DATETIME" ? "" : null, { shouldValidate: revalidate });
		form.setValue("offsetAmount", next === "DATETIME" ? 0 : null, { shouldValidate: revalidate });
		form.setValue("offsetUnit", next === "DATETIME" ? "MINUTES" : null, { shouldValidate: revalidate });
		form.setValue("source", next === "CONTEXT" ? "DEVICE_NAME" : null, { shouldValidate: revalidate });
	};

	// The live preview: what the pattern currently prints. Fetched from the server because
	// `evaluateVariable` and the zone/locale it renders in are both server-side — this dialog has
	// no idea what `variables.timezone` or `variables.locale` are set to. Debounced so a pattern
	// typed character by character fires one request per pause rather than one per keystroke.
	useEffect(() => {
		if (kind !== "DATETIME") {
			return;
		}
		const timer = setTimeout(() => {
			void previewMoment(pattern ?? "", offsetAmount, offsetUnit).then(setPreview);
		}, PREVIEW_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [kind, pattern, offsetAmount, offsetUnit]);

	const close = (): void => setOpen(false);

	/** Returns the dialog to its opening state. Safe to call more than once. */
	const reset = (): void => {
		setError(null);
		setPreview({ text: null, error: null });
		form.reset(toFormValues(initial));
	};

	const onSubmit = form.handleSubmit((values) => {
		setError(null);
		startSave(async () => {
			const result = await saveVariable(variableId ?? null, values);
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success(variableId ? `${values.name} saved.` : `${values.name} added.`);
			setOpen(false);
		});
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					reset();
				}
			}}
			onOpenChangeComplete={(nowOpen) => {
				if (!nowOpen) {
					reset();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>{variableId ? "Edit variable" : "New variable"}</DialogTitle>
					<DialogDescription>
						Written as <span className="font-mono">{`{${name || "name"}}`}</span> in a receipt's markup, and filled in
						with what is defined here when the receipt is printed.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="variable-name">Name</FieldLabel>
							<Input id="variable-name" className="font-mono" disabled={saving} {...form.register("name")} />
							<FieldDescription>Lowercase letters, numbers, dashes and underscores.</FieldDescription>
							<FieldError errors={[form.formState.errors.name]} />
						</Field>

						<Field>
							<FieldLabel>Kind</FieldLabel>
							<Controller
								control={form.control}
								name="kind"
								render={({ field }) => (
									<Select
										value={field.value}
										disabled={saving}
										onValueChange={(next) => {
											if (next !== null) {
												changeKindTo(next as VariableKind);
											}
										}}
									>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{VariableKind.values.map((value) => (
												<SelectItem key={value} value={value}>
													{KIND_LABELS[value]}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							/>
						</Field>

						{kind === "STATIC" ? (
							<Controller
								control={form.control}
								name="value"
								render={({ field }) => (
									<Field>
										<FieldLabel htmlFor="variable-value">Value</FieldLabel>
										<Input
											id="variable-value"
											disabled={saving}
											value={field.value ?? ""}
											onChange={(event) => field.onChange(event.target.value)}
										/>
										<FieldError errors={[form.formState.errors.value]} />
									</Field>
								)}
							/>
						) : null}

						{kind === "DATETIME" ? (
							<>
								<Controller
									control={form.control}
									name="pattern"
									render={({ field }) => (
										<Field>
											<FieldLabel htmlFor="variable-pattern">Pattern</FieldLabel>
											<Input
												id="variable-pattern"
												className="font-mono"
												disabled={saving}
												placeholder="HH:mm"
												value={field.value ?? ""}
												onChange={(event) => field.onChange(event.target.value)}
											/>
											<div className="flex flex-wrap gap-1.5">
												{PATTERN_PRESETS.map((presetPattern) => (
													<Button
														key={presetPattern}
														type="button"
														variant="outline"
														size="sm"
														className="h-7 font-mono text-[11.5px]"
														disabled={saving}
														onClick={() => field.onChange(presetPattern)}
													>
														{presetPattern}
													</Button>
												))}
											</div>
											{preview.error ? (
												<FieldDescription className="text-destructive">{preview.error}</FieldDescription>
											) : (
												<FieldDescription>
													Prints now: <span className="font-mono">{preview.text ?? "—"}</span>
												</FieldDescription>
											)}
											<FieldError errors={[form.formState.errors.pattern]} />
										</Field>
									)}
								/>

								<div className="grid grid-cols-2 gap-4">
									<Controller
										control={form.control}
										name="offsetAmount"
										render={({ field }) => (
											<Field>
												<FieldLabel htmlFor="variable-offset-amount">Shift by</FieldLabel>
												<Input
													id="variable-offset-amount"
													type="number"
													disabled={saving}
													value={field.value ?? 0}
													onChange={(event) => field.onChange(Number.parseInt(event.target.value, 10) || 0)}
												/>
											</Field>
										)}
									/>
									<Controller
										control={form.control}
										name="offsetUnit"
										render={({ field }) => (
											<Field>
												<FieldLabel>Unit</FieldLabel>
												<Select
													value={field.value ?? "MINUTES"}
													disabled={saving}
													onValueChange={(next) => {
														if (next !== null) {
															field.onChange(next);
														}
													}}
												>
													<SelectTrigger className="w-full">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{OffsetUnit.values.map((value) => (
															<SelectItem key={value} value={value}>
																{value.toLowerCase()}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</Field>
										)}
									/>
								</div>
								<FieldDescription>
									Applied before formatting. "Days", "weeks" and "months" shift by the printer's own calendar date;
									"minutes" and "hours" shift by elapsed time.
								</FieldDescription>
							</>
						) : null}

						{kind === "CONTEXT" ? (
							<Controller
								control={form.control}
								name="source"
								render={({ field }) => (
									<Field>
										<FieldLabel>Source</FieldLabel>
										<Select
											value={field.value ?? "DEVICE_NAME"}
											disabled={saving}
											onValueChange={(next) => {
												if (next !== null) {
													field.onChange(next);
												}
											}}
										>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{ContextSource.values.map((value) => (
													<SelectItem key={value} value={value}>
														{CONTEXT_LABELS[value]}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</Field>
								)}
							/>
						) : null}

						<Field>
							<FieldLabel htmlFor="variable-description">Description</FieldLabel>
							<Input
								id="variable-description"
								disabled={saving}
								{...form.register("description", { setValueAs: (value: string) => (value === "" ? null : value) })}
							/>
							<FieldDescription>Shown in the panel only. Never printed.</FieldDescription>
						</Field>

						<div className="flex items-start gap-2.5 border-t border-border pt-3">
							<Controller
								control={form.control}
								name="overridable"
								render={({ field }) => (
									<Checkbox
										id="variable-overridable"
										className="mt-0.5"
										checked={field.value}
										disabled={saving}
										onCheckedChange={(next) => field.onChange(next === true)}
									/>
								)}
							/>
							<FieldLabel htmlFor="variable-overridable" className="flex-col items-start gap-0.5 font-normal">
								<span>Overridable</span>
								<span className="text-[11.5px] font-normal text-subtle-foreground">
									Let a print request send its own value for this name. Off means this panel's value always wins.
								</span>
							</FieldLabel>
						</div>

						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" disabled={saving} onClick={close}>
						Cancel
					</Button>
					{/* Held shut while the live preview says `date-fns` cannot read the pattern. The server
					    refuses such a definition anyway — `requireValid` renders every `DATETIME` before
					    storing it — so this is not the check, it is the dialog agreeing with the check
					    rather than inviting a click whose only outcome is the same message again. */}
					<Button type="button" disabled={saving || (kind === "DATETIME" && preview.error !== null)} onClick={onSubmit}>
						{saving ? <Spinner className="size-3.5" /> : null}
						{variableId ? "Save" : "Create variable"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
