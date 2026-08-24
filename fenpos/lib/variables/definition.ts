import { z } from "zod";
import { MAX_NAME_LENGTH, nameSchema } from "@/lib/domain/naming";

/**
 * What a variable is, and what makes one valid.
 *
 * Deliberately not in `lib/domain/enums.ts`. That module's contract, stated in its own header, is
 * that every set it holds mirrors a Java enum under `agent/src/main/java/fi/natroutter/fenpos/enums/`
 * and that the two are changed in the same commit. Variables are resolved entirely on this side —
 * a compiled job crosses the link with every reference already substituted into spans, so the agent
 * has no notion of a variable to keep in step with. Putting these there would attach a promise that
 * nothing keeps and that a later reader would waste time trying to honour.
 *
 * Nothing here touches the database, the clock, or the network. That is what lets the rules be
 * tested as rules.
 */

/**
 * Builds the artefacts for one closed value set: the tuple for the panel, a schema for anything
 * crossing a trust boundary, and a guard for narrowing a column Prisma types as `string`.
 *
 * A local copy of the helper in `lib/domain/enums.ts` rather than an import of it, because
 * importing would tie this module to one whose header promises agent parity that these sets do not
 * have. The duplication is nine lines and it keeps the two contracts separable.
 *
 * @param values the permitted values
 * @returns the value tuple, its Zod schema, and a type guard over it
 */
function closedSet<const T extends readonly [string, ...string[]]>(values: T) {
	return {
		values,
		schema: z.enum(values),
		is(value: string): value is T[number] {
			return (values as readonly string[]).includes(value);
		},
	} as const;
}

/** How a variable's value is arrived at. */
export const VariableKind = closedSet(["STATIC", "DATETIME", "CONTEXT"] as const);
export type VariableKind = (typeof VariableKind.values)[number];

/** The unit a `DATETIME` offset is counted in. Coarsest last, which is the order the panel lists them. */
export const OffsetUnit = closedSet(["MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS"] as const);
export type OffsetUnit = (typeof OffsetUnit.values)[number];

/**
 * What a `CONTEXT` variable reads.
 *
 * `JOB_ID` is deliberately absent. Every source here is known before the job row exists, which is
 * what lets variables resolve alongside images and before anything is written; the job's id is not,
 * because `dispatch.ts` lets the database generate it and calls `compile` only afterwards. Adding it
 * means generating the id in application code first — a change worth making on its own merits, since
 * `dispatch.ts` already names it as the fix for the `lines: null` window it documents, and not one to
 * smuggle in here.
 */
export const ContextSource = closedSet(["DEVICE_NAME", "AGENT_NAME", "API_KEY_NAME"] as const);
export type ContextSource = (typeof ContextSource.values)[number];

/**
 * The hard ceiling on a stored value, independent of the `variables.maxValueChars` setting.
 *
 * The setting is the operator's policy and can be raised; this is the bound past which no policy
 * applies, so a column cannot be filled with megabytes by an operator who set the number too high.
 */
export const MAX_VALUE_CHARS_CEILING = 4096;

/**
 * A variable reference at the start of the given text.
 *
 * Anchored, so the parser can test the position it is standing on without scanning ahead. The name
 * pattern mirrors `NAME_PATTERN` in `lib/domain/naming.ts` and is bounded at that module's
 * {@link MAX_NAME_LENGTH}, so anything this matches is a name that could legally exist — a test
 * pins the two together. Bounding matters beyond tidiness: without it, `{` followed by a thousand
 * legal characters would match, only to be refused as unknown one step later.
 *
 * Text that is not name-shaped is not a reference at all, which is what keeps `Table {1 of 4}`
 * printable without an escape.
 */
export const VARIABLE_REFERENCE = /^\{([a-z0-9][a-z0-9_-]{0,63})\}/;

/**
 * Whether text contains a character the printer would read as a command.
 *
 * C0 (except nothing — not even tab, which ESC/POS treats as a horizontal-tab command), DEL, and
 * C1. The same set `parser.ts`'s own `isControl` refuses while scanning; this exists because a
 * variable's value never passes through that scan.
 *
 * @param text the candidate value
 * @returns true if any character would be interpreted rather than printed
 */
export function hasControlCharacter(text: string): boolean {
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			return true;
		}
	}
	return false;
}

/** One variable, as the panel and the API describe it. Mirrors the `Variable` table's columns. */
export interface VariableDefinition {
	name: string;
	kind: VariableKind;
	/** `STATIC` only: the literal text. */
	value: string | null;
	/** `DATETIME` only: a `date-fns` format pattern. */
	pattern: string | null;
	/** `DATETIME` only: how far to shift before formatting. Signed; null for no shift. */
	offsetAmount: number | null;
	/** `DATETIME` only: the unit {@link VariableDefinition.offsetAmount} counts in. */
	offsetUnit: OffsetUnit | null;
	/** `CONTEXT` only: which fact about the print to read. */
	source: ContextSource | null;
	/** Whether a print job may supply its own value for this name. */
	overridable: boolean;
	description: string | null;
}

/** Text with nothing in it the printer would obey, bounded by the hard ceiling. */
const printableValue = z
	.string()
	.max(MAX_VALUE_CHARS_CEILING, `A value must be at most ${MAX_VALUE_CHARS_CEILING} characters.`)
	.refine((text) => !hasControlCharacter(text), "A value cannot contain control characters.");

/**
 * Validates one variable definition, including the cross-field rules a column-by-column check
 * cannot express.
 *
 * The refinements are what stop a row from carrying fields belonging to a kind it is not. A `STATIC`
 * variable with a `pattern` set is not merely untidy: whoever reads that row next has to guess which
 * field was meant, and the guess is silent either way. Refusing it means the table only ever holds
 * rows that mean exactly one thing.
 */
export const variableDefinitionSchema = z
	.object({
		name: nameSchema,
		kind: VariableKind.schema,
		value: printableValue.nullable(),
		pattern: z.string().min(1).max(120).nullable(),
		offsetAmount: z.int().min(-100_000).max(100_000).nullable(),
		offsetUnit: OffsetUnit.schema.nullable(),
		source: ContextSource.schema.nullable(),
		overridable: z.boolean(),
		description: printableValue.max(500).nullable(),
	})
	.refine((definition) => (definition.kind === "STATIC") === (definition.value !== null), {
		message: "A static variable needs a value, and only a static variable may have one.",
		path: ["value"],
	})
	.refine((definition) => (definition.kind === "DATETIME") === (definition.pattern !== null), {
		message: "A date & time variable needs a pattern, and only one may have a pattern.",
		path: ["pattern"],
	})
	.refine((definition) => (definition.kind === "CONTEXT") === (definition.source !== null), {
		message: "A context variable needs a source, and only one may have a source.",
		path: ["source"],
	})
	.refine((definition) => (definition.offsetAmount === null) === (definition.offsetUnit === null), {
		message: "An offset needs both an amount and a unit.",
		path: ["offsetUnit"],
	})
	.refine((definition) => definition.kind === "DATETIME" || definition.offsetAmount === null, {
		message: "Only a date & time variable may carry an offset.",
		path: ["offsetAmount"],
	});
