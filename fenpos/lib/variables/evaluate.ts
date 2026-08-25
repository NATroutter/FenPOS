import { tz } from "@date-fns/tz";
import { add, type Locale } from "date-fns";
import { de, enGB, enUS, fi, fr, sv } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import type { OffsetUnit, VariableDefinition } from "@/lib/variables/definition";

/**
 * Turns one variable definition into the text that prints.
 *
 * A pure function of four arguments, and deliberately so: the clock, the print's context and the
 * formatting all arrive as parameters rather than being read here. That is what lets a receipt's
 * variables share one instant — `resolveVariables` captures `now` once and passes the same `Date`
 * to every call, so `{time_hm}` and `{time_full}` on one receipt cannot straddle a second boundary
 * and disagree with each other — and it is what lets every case above be tested against a fixed
 * date instead of against whatever time the suite happens to run at.
 */

/** The locales a `DATETIME` pattern may be rendered in. The same six `panel.locale` offers. */
export const VariableLocale = {
	values: ["en-US", "en-GB", "fi-FI", "sv-SE", "de-DE", "fr-FR"] as const,
	schema: z.enum(["en-US", "en-GB", "fi-FI", "sv-SE", "de-DE", "fr-FR"] as const),
} as const;
export type VariableLocale = (typeof VariableLocale.values)[number];

/**
 * Locale codes to the `date-fns` locale objects that render their month and day names.
 *
 * A static map rather than `import(\`date-fns/locale/${code}\`)`. A dynamic specifier defeats the
 * bundler's ability to see what is reachable, which at six entries buys nothing and costs the
 * guarantee that every locale the settings offer is actually present in the build. It is also the
 * reason `variables.locale` is a closed set rather than free text: the set is exactly this map's
 * keys, so a setting that validates is a setting that can be rendered.
 */
const LOCALES: Record<VariableLocale, Locale> = {
	"en-US": enUS,
	"en-GB": enGB,
	"fi-FI": fi,
	"sv-SE": sv,
	"de-DE": de,
	"fr-FR": fr,
};

/**
 * How many milliseconds one `MINUTES`/`HOURS` offset unit is worth.
 *
 * These two units are elapsed real time — "in two hours" means two real hours pass, full stop —
 * so they are added to the instant as milliseconds and never touch a calendar or a zone at all.
 */
const MILLIS_PER_UNIT: Record<Extract<OffsetUnit, "MINUTES" | "HOURS">, number> = {
	MINUTES: 60_000,
	HOURS: 3_600_000,
};

/**
 * `date-fns`'s `add` takes a duration keyed by unit; this is the translation for the three units
 * that are calendar arithmetic rather than elapsed time. See {@link shiftInstant} for why `DAYS`,
 * `WEEKS` and `MONTHS` are handled separately from `MINUTES` and `HOURS`.
 */
const CALENDAR_DURATION_KEY: Record<Extract<OffsetUnit, "DAYS" | "WEEKS" | "MONTHS">, "days" | "weeks" | "months"> = {
	DAYS: "days",
	WEEKS: "weeks",
	MONTHS: "months",
};

/** Facts about the print a `CONTEXT` variable can read. */
export interface PrintContext {
	deviceName: string;
	agentName: string;
	/** Null when the panel submitted the job rather than an API key. */
	apiKeyName: string | null;
}

/** How a `DATETIME` variable is rendered. */
export interface Formatting {
	/** An IANA zone. `resolveVariables` has already translated the `system` sentinel away. */
	timeZone: string;
	locale: VariableLocale;
}

/**
 * Evaluates one variable.
 *
 * @param definition the variable, already validated
 * @param now the instant this job is being compiled at, shared across the whole job
 * @param context facts about the print, for a `CONTEXT` variable
 * @param formatting the zone and locale a `DATETIME` renders in
 * @returns the text to substitute, which may legitimately be empty
 * @throws Error if a `DATETIME` carries a pattern the formatter cannot read
 */
export function evaluateVariable(
	definition: VariableDefinition,
	now: Date,
	context: PrintContext,
	formatting: Formatting,
): string {
	switch (definition.kind) {
		case "STATIC":
			// Returned as-is, never re-read. A brace in here prints as a brace, which is the whole of
			// why no recursion exists anywhere in this feature.
			return definition.value ?? "";

		case "DATETIME":
			return formatMoment(definition, now, formatting);

		case "CONTEXT":
			switch (definition.source) {
				case "DEVICE_NAME":
					return context.deviceName;
				case "AGENT_NAME":
					return context.agentName;
				case "API_KEY_NAME":
					// Empty rather than a placeholder like "panel". A receipt printed from the Tools
					// page genuinely was not submitted by a key, and inventing a name for that would
					// put a word on the paper that names nothing.
					return context.apiKeyName ?? "";
				default:
					return "";
			}
	}
}

/**
 * Shifts and formats an instant.
 *
 * `MINUTES` and `HOURS` are elapsed time and `DAYS`, `WEEKS` and `MONTHS` are calendar units in
 * `formatting.timeZone` — see {@link shiftInstant} for why those are two genuinely different
 * operations rather than one. The formatter is applied after the shift either way, once
 * {@link shiftInstant} has produced the instant that is actually meant.
 *
 * @param definition the variable, whose `pattern` is non-null by validation
 * @param now the instant to render
 * @param formatting the zone and locale to render in
 * @returns the formatted text
 * @throws Error naming the variable if the pattern is not one `date-fns` accepts
 */
function formatMoment(definition: VariableDefinition, now: Date, formatting: Formatting): string {
	const shifted = shiftInstant(definition, now, formatting);

	try {
		return formatInTimeZone(shifted, formatting.timeZone, definition.pattern ?? "", {
			locale: LOCALES[formatting.locale],
		});
	} catch (error) {
		// `date-fns` throws on an unsupported token — `YYYY` and `DD` in particular, which it rejects
		// on purpose because they are almost always a mistake for `yyyy` and `dd`. Rethrown naming the
		// variable, because the message it raises describes a token and the operator needs to know
		// which of their variables carries it.
		throw new Error(
			`Variable '${definition.name}' has a pattern this system cannot format: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		);
	}
}

/**
 * Applies a `DATETIME` variable's offset, if it has one.
 *
 * `MINUTES` and `HOURS` are elapsed real time: "in two hours" means two real hours pass regardless
 * of what any clock on the wall does in between, so they are added to the instant as milliseconds
 * and never consult a zone.
 *
 * `DAYS`, `WEEKS` and `MONTHS` are calendar units, and a calendar only exists inside a zone: "in
 * fourteen days" means the same wall-clock time, fourteen calendar days later, *in the shop's own
 * zone* — that is what a shop means by a return-by date, and it is what keeps that date from
 * sliding by an hour, and twice a year possibly a day, across a daylight-saving transition.
 *
 * The obvious-looking alternative — call `date-fns`'s plain `add`, on the theory that shifting the
 * absolute instant first and formatting into the zone afterward avoids exactly that sliding — is
 * the bug this replaced. `add`'s day/week/month arithmetic is calendar-aware, but the calendar it
 * consults is read off the `Date` object's local getters and setters, which are bound to
 * *whichever zone the host process happens to be running in* — not `formatting.timeZone`, and not
 * anything this function's four arguments carry. Two hosts running the identical build with the
 * identical arguments would print a different hour for the same receipt, decided by an OS setting
 * neither host owner would think to check. Binding the arithmetic to `formatting.timeZone`
 * explicitly, via `@date-fns/tz`'s `in` context, is what makes the answer depend on the zone the
 * shop configured and nothing else — do not simplify this back to a bare `add(now, ...)`.
 *
 * @param definition the variable, carrying the offset to apply, if any
 * @param now the instant to shift
 * @param formatting supplies the zone `DAYS`/`WEEKS`/`MONTHS` arithmetic runs in
 * @returns the shifted instant, or `now` unchanged if the variable carries no offset
 */
function shiftInstant(definition: VariableDefinition, now: Date, formatting: Formatting): Date {
	if (definition.offsetAmount === null || definition.offsetUnit === null) {
		return now;
	}

	if (definition.offsetUnit === "MINUTES" || definition.offsetUnit === "HOURS") {
		return new Date(now.getTime() + definition.offsetAmount * MILLIS_PER_UNIT[definition.offsetUnit]);
	}

	const inShopZone = add(
		now,
		{ [CALENDAR_DURATION_KEY[definition.offsetUnit]]: definition.offsetAmount },
		{ in: tz(formatting.timeZone) },
	);
	// `add` with an `in` context returns a `TZDate`, not a plain `Date`. Its instant is exactly what
	// is wanted, but re-wrapping it keeps this function's return type — and every caller's
	// assumptions about what a `Date` supports — the same regardless of which branch ran.
	return new Date(inShopZone.getTime());
}
