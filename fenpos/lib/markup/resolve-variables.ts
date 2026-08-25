import "server-only";

import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { VariableContext } from "@/lib/markup/parser";
import { booleanSetting, integerSetting } from "@/lib/settings/settings-service";
import type { VariableDefinition } from "@/lib/variables/definition";
import { evaluateVariable, type Formatting, type PrintContext } from "@/lib/variables/evaluate";
import { printedFormatting } from "@/lib/variables/formatting";
import { requireValueWithinCap, type SuppliedValue } from "@/lib/variables/supplied";
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
	/**
	 * Values the request carried, if any. Names here need not exist as variables.
	 *
	 * A value is either literal text or a date the caller described and this install renders — see
	 * `SuppliedValue`. Both are the same field of the same request, and both obey the same gates
	 * below; what differs is only that one of them is not text until this function makes it text.
	 */
	supplied: Readonly<Record<string, SuppliedValue>>;
}

/**
 * Resolves every variable for one job.
 *
 * @param job the printer, the print's context, and any values the request carried
 * @param now the instant to evaluate dates against; defaults to the real clock, and is a parameter
 *        so a test can pin it. One instant serves the whole job, so two date variables on one
 *        receipt cannot disagree about what time it is.
 * @returns the values and the per-element limit, or null when variables are switched off — which
 *          the parser reads as "braces are ordinary text". A defined variable that could not be
 *          evaluated is absent from the map rather than being an error for the whole job; see the
 *          catch inside for why that containment is the point.
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

	const formatting = await printedFormatting();

	const defined = await listVariables();
	const overrides = await listDeviceOverrides(job.deviceId);

	const values = new Map<string, string>();
	const overridable = new Set<string>();
	// Every name that has a row, evaluated or not. Kept apart from `values` because the two answer
	// different questions and a failed evaluation makes them differ: a variable that could not be
	// rendered is still one this install has an opinion about, so a job must not gain the right to
	// supply its own value for it merely because the row is broken.
	const definedNames = new Set<string>();

	for (const variable of defined) {
		definedNames.add(variable.name);
		if (variable.overridable) {
			overridable.add(variable.name);
		}

		// The device's own value wins over the definition's, and only a static variable can have one —
		// `setDeviceOverride` is what enforces that, so an override found here is known to belong to a
		// variable whose value is simply text. Short-circuiting matters beyond speed: an overridden
		// variable is not evaluated at all, so it cannot fail below.
		const override = overrides.get(variable.name);
		if (override !== undefined) {
			values.set(variable.name, override);
			continue;
		}

		try {
			values.set(variable.name, evaluateVariable(variable, now, job.context, formatting));
		} catch (error) {
			// **One unrenderable row must not take down every print on the install.** This loop
			// evaluates *every* defined variable on *every* job, whether or not the receipt mentions
			// them, so a throw escaping here escapes `submitJob` and becomes an opaque 500 for every
			// printer, every key and every receipt — including receipts that name nothing dynamic at
			// all, and with no job row to show the operator what happened. Omitting the name instead
			// degrades the blast radius to exactly the receipts that reference it, which then fail as
			// `unknown_variable` with the name and column, like any other bad reference.
			//
			// `requireValid` is what stops such a row being saved in the first place, and is the real
			// fix; this is what keeps the ones already in the table — or arriving by any future write
			// path — from being an install-wide outage. `resolveOne` in `app/(panel)/tools/actions.ts`
			// takes the same position for the same reason.
			logger.error(`Could not resolve variable '${variable.name}'; it will read as undefined for this job`, error, {
				deviceId: job.deviceId,
			});
		}
	}

	// Read once and only if a date actually needs it. Every other value in this loop is already text,
	// and the overwhelming majority of jobs send none of these at all, so the common path pays nothing
	// for a setting it does not consult.
	let maxValueChars: number | null = null;

	for (const [name, value] of supplied) {
		// A name nothing defines is allowed through: requiring a panel row for every per-job value
		// would mean a panel change every time the caller's receipts grow a field. A *defined* name is
		// another matter — that is a value this install has an opinion about, and the opinion is the
		// `overridable` flag. It applies to a date the caller described exactly as it does to text:
		// what is being replaced is the install's answer for that name, whoever computes it.
		if (definedNames.has(name) && !overridable.has(name)) {
			throw new ApiError(
				"variable_not_overridable",
				`The variable '${name}' is defined here and is not marked as overridable, so a print request cannot replace it.`,
			);
		}

		if (value.kind === "text") {
			values.set(name, value.text);
			continue;
		}

		const rendered = renderSuppliedMoment(name, value, now, job.context, formatting);
		maxValueChars ??= await integerSetting("variables.maxValueChars");
		// The *rendered* text, not the pattern. `readSuppliedVariables` deliberately left this
		// unmeasured because no clock exists in that module, and a pattern's length is the wrong thing
		// to measure anyway: `'……'` puts quoted literal text on paper, so a short pattern can render
		// long. Capping here is what stops an object bypassing the limit every string obeys.
		requireValueWithinCap(name, rendered, maxValueChars);
		values.set(name, rendered);
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
 * Renders a date the caller described.
 *
 * Built into a `VariableDefinition` and handed to `evaluateVariable` — the same function a
 * panel-defined `DATETIME` goes through, against the same `now` and the same `formatting` — rather
 * than formatting here. That is the whole point: a caller-supplied pattern and a panel-defined one
 * cannot diverge in behaviour if there is only one implementation, offset arithmetic and DST
 * handling included.
 *
 * The throw is deliberate, and deliberately unlike the `catch` in the loop above. That one swallows a
 * broken *stored* row, because a row is the install's and one of them must not take down every print
 * on it. This one is the *caller's* own pattern, arriving with the request it belongs to: refusing
 * tells them what is wrong with what they sent, and it refuses nothing else — the next job on this
 * install, and every job that sent no pattern, is untouched.
 *
 * @param name the variable being supplied, for the message and for the definition's own name field
 * @param value the pattern and optional offset the request carried
 * @param now the job's single instant
 * @param context the print's facts; unused by a `DATETIME`, and passed only because
 *        `evaluateVariable` takes one
 * @param formatting the install's zone and locale — never the caller's
 * @returns the formatted text
 * @throws ApiError when the pattern is not one `date-fns` accepts
 */
function renderSuppliedMoment(
	name: string,
	value: Extract<SuppliedValue, { kind: "moment" }>,
	now: Date,
	context: PrintContext,
	formatting: Formatting,
): string {
	const definition: VariableDefinition = {
		name,
		kind: "DATETIME",
		value: null,
		pattern: value.pattern,
		// The one place the nested `offset` becomes the flat pair the definition uses. Nesting is what
		// makes "an amount without a unit" unrepresentable in a request; the pair is what the stored
		// shape has always been, and `evaluateVariable` reads that.
		offsetAmount: value.offset?.amount ?? null,
		offsetUnit: value.offset?.unit ?? null,
		source: null,
		// Nothing reads this — the gate has already been passed by the time this is called — but a
		// definition claiming to be locked while standing in for a value a request supplied would be a
		// lie to whoever reads it next.
		overridable: true,
		description: null,
	};

	try {
		return evaluateVariable(definition, now, context, formatting);
	} catch (error) {
		// `evaluateVariable` already names the variable in its message and says which token it could
		// not read, so it is passed through rather than wrapped in a second sentence saying less — but
		// trimmed first, and only here. `date-fns` appends a ` to the input <Date.toString()>; see: …`
		// clause naming the exact instant it tried to format, rendered in the host process's own local
		// zone and, for the zone's name, whatever language the host OS is set to — which is how this
		// server's clock, time zone and a foreign-language string could all leak into a caller's API
		// response. `evaluate.ts` itself keeps the full message, because there it only ever reaches the
		// logs and the panel — both this install's own, not a caller's.
		throw new ApiError("invalid_variable", trimDateFnsMessage(error, name));
	}
}

/**
 * The message `renderSuppliedMoment` hands back to the caller, with `date-fns`'s own trailing clause
 * cut off.
 *
 * Cuts at the first `" to the input "`, which is present in every message `date-fns` throws for a
 * pattern it refuses. When it is absent — an error from anywhere else, or a future `date-fns`
 * rewording that drops the clause — the message passes through unchanged, so this degrades to
 * today's un-trimmed behaviour rather than to something empty or misleading.
 *
 * @param error whatever `evaluateVariable` threw
 * @param name the variable being supplied, for the fallback when `error` carries no message at all
 * @returns the message to report to the caller
 */
function trimDateFnsMessage(error: unknown, name: string): string {
	if (!(error instanceof Error)) {
		return `The variable '${name}' has a pattern this server cannot format.`;
	}
	const cutAt = error.message.indexOf(" to the input ");
	return cutAt === -1 ? error.message : error.message.slice(0, cutAt);
}
