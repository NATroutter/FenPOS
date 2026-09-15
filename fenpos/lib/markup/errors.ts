/**
 * The ways a `data` document can be malformed.
 *
 * Each code is part of the public API contract: clients branch on the `error` field, so these
 * strings are frozen independently of anything in the implementation. Ported verbatim from
 * `MarkupError.java`.
 */

/** Stable machine-readable codes for markup failures. */
export const MARKUP_ERRORS = {
	/** A tag name that is not in the registry. */
	unknownTag: "unknown_tag",
	/** A paired tag opened but never closed before the document ended. */
	unclosedTag: "unclosed_tag",
	/** A closing tag with no matching open tag, or one closing the wrong tag. */
	unexpectedCloseTag: "unexpected_close_tag",
	/** What a tag encloses is missing or malformed: a symbol's payload, an image reference, a series' values. */
	invalidTagArgument: "invalid_tag_argument",
	/** An alignment tag that does not own its whole line, or a second one. */
	invalidAlignScope: "invalid_align_scope",
	/** A wrap tag that does not own its whole line, or a second one. */
	invalidWrapScope: "invalid_wrap_scope",
	/** A rule tag sharing a line with other content. */
	invalidRuleScope: "invalid_rule_scope",
	/** A block tag sharing a line with other content, or containing markup rather than data. */
	invalidBlockScope: "invalid_block_scope",
	/**
	 * A symbol measured wider than the device's paper.
	 *
	 * The one code here with no counterpart in `MarkupError.java`, and raised later than every
	 * other code here: how wide the paper is belongs to the device rather than to the line, so
	 * it is the compiler that knows, not the parser. It still arrives as a markup error because it
	 * names a tag and a column, and because what the caller has to change is the markup — a smaller
	 * module size, shorter content, a different symbology.
	 *
	 * Server-only because measuring a symbol needs an encoder, and the design keeps exactly one of
	 * those. The agent parses block tags too, but cannot measure them and so cannot raise this —
	 * see `PrintCompiler.countTextLines` for what that costs and why it is accepted.
	 */
	symbolTooWide: "symbol_too_wide",
	/**
	 * A `{name}` naming no variable this device can resolve.
	 *
	 * Server-only, for the same reason {@link MARKUP_ERRORS.symbolTooWide} is: resolving a name needs
	 * the `variables` table and the device's own overrides, and the agent's parser has neither. A
	 * compiled job crosses the link with every reference already substituted into spans, so the agent
	 * never meets a reference and cannot raise this. Markup parsed on the agent's own console leaves
	 * braces as ordinary text — which is what this system does anyway when the feature is off.
	 */
	unknownVariable: "unknown_variable",
	/**
	 * More `{name}` references on one line than `variables.maxPerElement` allows.
	 *
	 * Deliberately not the same code as the request-level `too_many_variables`, which counts entries
	 * in the body's `variables` object. One is about how much a caller supplied, the other about how
	 * much one line asks to expand; a client branching on the code has to be able to tell them apart.
	 */
	tooManyVariableReferences: "too_many_variable_references",
	/** A character that would be interpreted by the printer as a command. */
	controlCharacter: "control_character",
	/** Blocks nested deeper than `limits.maxBlockDepth`. */
	nestingTooDeep: "nesting_too_deep",
	/** An attribute the tag does not declare. */
	unknownAttribute: "unknown_attribute",
	/** An attribute that is required and missing, set twice, or given a value outside what the tag accepts; or a table whose sized columns exceed the width. */
	invalidAttribute: "invalid_attribute",
	/** A block where it cannot go: a row outside a table, a cell outside a row, a symbol inside a box. */
	misplacedBlock: "misplaced_block",
	/** More labels than a chart has categories. */
	tooManyLabels: "too_many_labels",
	/** A `<text>` naming a font that is not stored. */
	unknownFont: "unknown_font",
	/** More cells in one table than `limits.maxTableCells`. */
	tooManyCells: "too_many_cells",
	/** More values in one series than `limits.maxSeriesPoints`. */
	tooManyPoints: "too_many_points",
	/** The job's rasters together exceed `limits.maxRasterMb`. */
	rasterBudgetExceeded: "raster_budget_exceeded",
	/** An `<image>` data URI that is not a PNG or JPEG, or not base64. */
	invalidImageData: "invalid_image_data",
	/** A font upload that opentype.js cannot parse. */
	invalidFont: "invalid_font",
} as const;

export type MarkupErrorCode = (typeof MARKUP_ERRORS)[keyof typeof MARKUP_ERRORS];

/**
 * A malformed document, with where it went wrong.
 *
 * The line and column are the whole point. A `400` that says "invalid markup" makes a caller
 * re-read their own string; one that names the line, the character, and its position tells them
 * what to change.
 */
export class MarkupError extends Error {
	/** Stable code for the API's `error` field. */
	readonly code: MarkupErrorCode;

	/** 1-based line of the document where the problem starts. */
	readonly line: number;

	/** 1-based column within that line where the problem starts. */
	readonly column: number;

	/** The offending token or character, or null when the error needs no further identification. */
	readonly detail: string | null;

	constructor(code: MarkupErrorCode, line: number, column: number, detail: string | null, message: string) {
		super(message);
		this.name = "MarkupError";
		this.code = code;
		this.line = line;
		this.column = column;
		this.detail = detail;
	}
}

/**
 * A character the device's codepage cannot represent.
 *
 * Separate from {@link MarkupError} because it is not a syntax problem: the markup is
 * well-formed and the text is simply unprintable on this printer, which is a different thing for
 * a caller to fix — change the text, or change the device's codepage.
 */
export class UnsupportedCharacterError extends Error {
	/** The character that cannot be represented. */
	readonly character: string;

	/**
	 * 1-based character position within the line.
	 *
	 * Points at the character itself for text the caller wrote. For a character that arrived by
	 * substitution it points at the `{name}` reference instead — see `columnAt` in
	 * `lib/markup/model.ts` for why a position inside a substituted value is not a position the
	 * line has — and {@link UnsupportedCharacterError.variable} names which one.
	 */
	readonly column: number;

	/** The codepage that cannot represent it. */
	readonly codepage: string;

	/**
	 * The variable whose value carried the character, or null when the caller typed it themselves.
	 *
	 * What replaces the exactness {@link UnsupportedCharacterError.column} cannot have here: the
	 * column says which reference, this says which variable's value to go and fix.
	 */
	readonly variable: string | null;

	constructor(character: string, column: number, codepage: string, variable: string | null = null) {
		super(
			`Character '${character}' (U+${character
				.codePointAt(0)
				?.toString(16)
				.toUpperCase()
				.padStart(4, "0")}) cannot be printed in codepage ${codepage}${
				variable === null ? "" : `; it came from the value of '${variable}'`
			}`,
		);
		this.name = "UnsupportedCharacterError";
		this.character = character;
		this.column = column;
		this.codepage = codepage;
		this.variable = variable;
	}
}
