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

/** `date-fns`'s `add` takes a duration keyed by unit; this is the translation. */
const DURATION_KEY: Record<OffsetUnit, "minutes" | "hours" | "days" | "weeks" | "months"> = {
	MINUTES: "minutes",
	HOURS: "hours",
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
 * The shift happens on the absolute instant and the zone is applied by the formatter, which is the
 * order that makes "+1 month" mean a calendar month rather than a fixed span — `add` is
 * calendar-aware, and doing the arithmetic on a zone-shifted wall clock instead would double-count
 * a daylight-saving transition.
 *
 * @param definition the variable, whose `pattern` is non-null by validation
 * @param now the instant to render
 * @param formatting the zone and locale to render in
 * @returns the formatted text
 * @throws Error naming the variable if the pattern is not one `date-fns` accepts
 */
function formatMoment(definition: VariableDefinition, now: Date, formatting: Formatting): string {
	const shifted =
		definition.offsetAmount !== null && definition.offsetUnit !== null
			? add(now, { [DURATION_KEY[definition.offsetUnit]]: definition.offsetAmount })
			: now;

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
