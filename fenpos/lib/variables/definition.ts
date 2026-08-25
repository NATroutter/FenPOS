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
 * Grouped by what each describes — the printer, the machine driving it, who asked, and the install —
 * because that is the order the panel's picker lists them in and the order an operator scanning the
 * list thinks in.
 *
 * **Every source here is knowable before the job row exists**, and that is the membership rule rather
 * than an accident. Variables resolve ahead of `resolveImages`, which itself runs before anything is
 * written, because an `<image>{logo}</image>` names no image until substitution has happened. A
 * source that could only be read afterwards would have to be threaded through a different seam
 * entirely.
 *
 * `JOB_ID` is the one that fails that rule and is deliberately still absent: `dispatch.ts` lets the
 * database mint the id and calls `compile` only afterwards, so adding it means generating the id in
 * application code first. That is a change worth making on its own merits — `dispatch.ts` already
 * names it as the fix for the `lines: null` window it documents — and not one to smuggle in beside a
 * list of fields that were free.
 */
export const ContextSource = closedSet([
	"DEVICE_NAME",
	"PAPER_COLUMNS",
	"PAPER_WIDTH",
	"CODEPAGE",
	"AGENT_NAME",
	"AGENT_HOSTNAME",
	"AGENT_PLATFORM",
	"AGENT_VERSION",
	"API_KEY_NAME",
	"IDEMPOTENCY_KEY",
	"SERVER_URL",
] as const);
export type ContextSource = (typeof ContextSource.values)[number];

/**
 * The hard ceiling on a stored value, independent of the `variables.maxValueChars` setting.
 *
 * The setting is the operator's policy and can be raised; this is the bound past which no policy
 * applies, so a column cannot be filled with megabytes by an operator who set the number too high.
 */
export const MAX_VALUE_CHARS_CEILING = 4096;

/**
 * A variable reference, matched at exactly the position the caller is standing on.
 *
 * Sticky rather than anchored with `^`, and that is a performance property rather than a stylistic
 * one. An anchored pattern can only be applied to a string that *starts* where the match must start,
 * so the parser had to hand it `source.slice(index)` — a fresh copy of the remaining element on
 * every `{` it passed. `maxLineChars` is operator-configurable to 10,000, at which an element of
 * `{{{{…` costs tens of millions of character copies for a line nobody would ever print. `y` lets
 * `exec` start at an offset instead, so nothing is copied.
 *
 * Kept private and reached through {@link variableReferenceAt} because a sticky regex carries
 * `lastIndex` between calls: a second consumer that called `exec` without setting it first would get
 * answers about a position it never asked about, intermittently and only once some other caller had
 * matched. The helper owns that field, so no caller has to know it exists.
 *
 * The name pattern mirrors `NAME_PATTERN` in `lib/domain/naming.ts` and is bounded at that module's
 * {@link MAX_NAME_LENGTH}, so anything this matches is a name that could legally exist — a test
 * pins the two together. Bounding matters beyond tidiness: without it, `{` followed by a thousand
 * legal characters would match, only to be refused as unknown one step later.
 *
 * Text that is not name-shaped is not a reference at all, which is what keeps `Table {1 of 4}`
 * printable without an escape.
 */
const VARIABLE_REFERENCE = /\{([a-z0-9][a-z0-9_-]{0,63})\}/y;

/**
 * Matches a `{name}` reference beginning at exactly `index`, and nowhere else.
 *
 * Anchored at the position given rather than searching forward from it: the parser is standing on a
 * `{` and is asking what that particular brace is, so a reference found three characters later would
 * be the wrong answer.
 *
 * @param source the element text
 * @param index 0-based position the reference must begin at
 * @returns the match — `[0]` the whole reference, `[1]` the name — or null when this position does
 *          not begin one
 */
export function variableReferenceAt(source: string, index: number): RegExpExecArray | null {
	VARIABLE_REFERENCE.lastIndex = index;
	return VARIABLE_REFERENCE.exec(source);
}

/**
 * Whether one character is one the printer would read as a command rather than print.
 *
 * C0 (including tab, whose behaviour depends on printer-side tab stops the agent does not manage),
 * DEL, and C1.
 *
 * **This is the only statement of that rule.** {@link hasControlCharacter} below and `isControl` in
 * `lib/markup/parser.ts` are both defined in terms of it, and neither restates the ranges. They used
 * to: two spellings of the same set, in the two files that between them decide what may reach a
 * printer, with nothing asserting they agreed. They did agree — but if they ever drifted, a byte
 * refused when an author typed it into markup would become reachable by putting it in a variable's
 * value, which is precisely the hole the substitution check exists to close. A test pins the two
 * callers together across the boundary values.
 *
 * @param character a single character; a surrogate pair is never a control character either way
 * @returns true when it must not reach the printer
 */
export function isControlCharacter(character: string): boolean {
	const code = character.codePointAt(0) ?? 0;
	return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Whether text contains a character the printer would read as a command.
 *
 * The same rule {@link isControlCharacter} states, applied across a whole string. This exists
 * because a variable's value never passes through the parser's own character-by-character scan.
 *
 * @param text the candidate value
 * @returns true if any character would be interpreted rather than printed
 */
export function hasControlCharacter(text: string): boolean {
	for (const character of text) {
		if (isControlCharacter(character)) {
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

/**
 * Text with nothing in it the printer would obey, bounded by the hard ceiling.
 *
 * Exported so a write path that does not go through {@link variableDefinitionSchema} as a whole —
 * `setDeviceOverride` in `lib/variables/variable-service.ts`, which validates a bare value rather
 * than a full definition — still applies the same control-character rule rather than restating it.
 */
export const printableValue = z
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
