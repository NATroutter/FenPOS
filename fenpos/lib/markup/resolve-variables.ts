import "server-only";

import { ApiError } from "@/lib/errors";
import type { VariableContext } from "@/lib/markup/parser";
import { booleanSetting, enumSetting, integerSetting } from "@/lib/settings/settings-service";
import { evaluateVariable, type Formatting, type PrintContext, type VariableLocale } from "@/lib/variables/evaluate";
import { listDeviceOverrides, listVariables } from "@/lib/variables/variable-service";

/**
 * Gathers every value one job may substitute.
 *
 * The counterpart to `resolveImages`, and deliberately the same shape: it does the part that cannot
 * be synchronous, and hands the answer to a compile that stays a pure function of what it is given.
 * Unlike that one it touches no network — these are database rows — so it is the cheaper of the two
 * and runs first, which it must: `resolveImages` parses each element to find `<image>` references,
 * and `<image>{logo}</image>` only names an image once this has run.
 *
 * The three layers are flattened here rather than left for the parser to walk. A parser that had to
 * consult a job map, then a device map, then a table would be a parser that knows what a device is;
 * a flat `Map<string, string>` is the whole of what it needs to know.
 */

/** What one job brings to the resolution: which printer, what is true of the print, and what it supplied. */
export interface JobVariables {
	deviceId: string;
	context: PrintContext;
	/** Values the request carried, if any. Names here need not exist as variables. */
	supplied: Readonly<Record<string, string>>;
}

/**
 * Resolves every variable for one job.
 *
 * @param job the printer, the print's context, and any values the request carried
 * @param now the instant to evaluate dates against; defaults to the real clock, and is a parameter
 *        so a test can pin it. One instant serves the whole job, so two date variables on one
 *        receipt cannot disagree about what time it is.
 * @returns the values and the per-element limit, or null when variables are switched off — which
 *          the parser reads as "braces are ordinary text"
 * @throws ApiError if the request supplied values it may not
 */
export async function resolveVariables(job: JobVariables, now: Date = new Date()): Promise<VariableContext | null> {
	if (!(await booleanSetting("variables.enabled"))) {
		return null;
	}

	const supplied = Object.entries(job.supplied);
	if (supplied.length > 0) {
		await requireSuppliedValuesAllowed(supplied.length);
	}

	const formatting: Formatting = {
		timeZone: await printedTimeZone(),
		locale: await enumSetting<VariableLocale>("variables.locale"),
	};

	const defined = await listVariables();
	const overrides = await listDeviceOverrides(job.deviceId);

	const values = new Map<string, string>();
	const overridable = new Set<string>();

	for (const variable of defined) {
		if (variable.overridable) {
			overridable.add(variable.name);
		}

		// The device's own value wins over the definition's, and only a static variable can have one —
		// `setDeviceOverride` is what enforces that, so an override found here is known to belong to a
		// variable whose value is simply text.
		const override = overrides.get(variable.name);
		values.set(variable.name, override ?? evaluateVariable(variable, now, job.context, formatting));
	}

	for (const [name, value] of supplied) {
		// A name nothing defines is allowed through: requiring a panel row for every per-job value
		// would mean a panel change every time the caller's receipts grow a field. A *defined* name is
		// another matter — that is a value this install has an opinion about, and the opinion is the
		// `overridable` flag.
		if (values.has(name) && !overridable.has(name)) {
			throw new ApiError(
				"variable_not_overridable",
				`The variable '${name}' is defined here and is not marked as overridable, so a print request cannot replace it.`,
			);
		}
		values.set(name, value);
	}

	return { values, maxPerElement: await integerSetting("variables.maxPerElement") };
}

/**
 * Validates the `variables` object a request carried.
 *
 * Shape and per-value checks happen in `readRequest`, which is where the rest of the body is
 * checked; what is left here is the pair of questions that need a settings read.
 *
 * @param count how many names the request supplied
 * @throws ApiError if the install does not accept them, or there are too many
 */
async function requireSuppliedValuesAllowed(count: number): Promise<void> {
	if (!(await booleanSetting("variables.allowRequestValues"))) {
		throw new ApiError(
			"variables_not_allowed",
			"This install does not accept variable values from print requests. Define them in the panel instead.",
		);
	}

	const cap = await integerSetting("variables.maxPerRequest");
	if (count > cap) {
		throw new ApiError("too_many_variables", `At most ${cap} variable values are allowed per request, got ${count}.`);
	}
}

/**
 * Resolves `variables.timezone` to an IANA zone.
 *
 * The `system` sentinel means the server's own zone, which `Intl` names for us. Translated here
 * rather than passed down, so `evaluateVariable` always receives a real zone and never has to know
 * the sentinel exists — the same translation `resolveTimeZone` does for the panel's formatter.
 *
 * @returns the zone to format printed dates in
 */
async function printedTimeZone(): Promise<string> {
	const configured = await enumSetting<string>("variables.timezone");
	return configured === "system" ? Intl.DateTimeFormat().resolvedOptions().timeZone : configured;
}
