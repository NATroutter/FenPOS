/**
 * The ways a `data` element can be malformed.
 *
 * Each code is part of the public API contract: clients branch on the `error` field, so these
 * strings are frozen independently of anything in the implementation. Ported verbatim from
 * `MarkupError.java`.
 */

/** Stable machine-readable codes for markup failures. */
export const MARKUP_ERRORS = {
	/** A tag name that is not in the registry. */
	unknownTag: "unknown_tag",
	/** A paired tag opened but never closed before the element ended. */
	unclosedTag: "unclosed_tag",
	/** A closing tag with no matching open tag, or one closing the wrong tag. */
	unexpectedCloseTag: "unexpected_close_tag",
	/** A tag argument that is missing, malformed, or out of range. */
	invalidTagArgument: "invalid_tag_argument",
	/** An alignment tag that does not enclose the whole element, or a second one. */
	invalidAlignScope: "invalid_align_scope",
	/** A wrap tag that does not enclose the whole element, or a second one. */
	invalidWrapScope: "invalid_wrap_scope",
	/** A rule tag sharing an element with other content. */
	invalidRuleScope: "invalid_rule_scope",
	/**
	 * A block tag sharing an element with other content, or containing markup rather than data.
	 *
	 * The one code here with no counterpart in `MarkupError.java`, deliberately: the agent's
	 * parser was frozen before block tags existed and the server is now the only side that parses
	 * markup, so the agent can never raise this and mirroring it there would be dead code.
	 */
	invalidBlockScope: "invalid_block_scope",
	/**
	 * A symbol measured wider than the device's paper.
	 *
	 * Server-only for the same reason as `invalidBlockScope`, and raised later than every other
	 * code here: how wide the paper is belongs to the device rather than to the element, so it is
	 * the compiler that knows, not the parser. It still arrives as a markup error because it names
	 * a tag and a column, and because what the caller has to change is the markup — a smaller
	 * module size, shorter content, a different symbology.
	 */
	symbolTooWide: "symbol_too_wide",
	/** A character that would be interpreted by the printer as a command. */
	controlCharacter: "control_character",
} as const;

export type MarkupErrorCode = (typeof MARKUP_ERRORS)[keyof typeof MARKUP_ERRORS];

/**
 * A malformed element, with where it went wrong.
 *
 * The column is the whole point. A `400` that says "invalid markup" makes a caller re-read
 * their own string; one that names the character and its position tells them what to change.
 */
export class MarkupError extends Error {
	/** Stable code for the API's `error` field. */
	readonly code: MarkupErrorCode;

	/** 1-based character position within the element where the problem starts. */
	readonly column: number;

	/** The offending token or character, or null when the error needs no further identification. */
	readonly detail: string | null;

	constructor(code: MarkupErrorCode, column: number, detail: string | null, message: string) {
		super(message);
		this.name = "MarkupError";
		this.code = code;
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

	/** 1-based character position within the element. */
	readonly column: number;

	/** The codepage that cannot represent it. */
	readonly codepage: string;

	constructor(character: string, column: number, codepage: string) {
		super(
			`Character '${character}' (U+${character
				.codePointAt(0)
				?.toString(16)
				.toUpperCase()
				.padStart(4, "0")}) cannot be printed in codepage ${codepage}`,
		);
		this.name = "UnsupportedCharacterError";
		this.character = character;
		this.column = column;
		this.codepage = codepage;
	}
}
