import type { Align, BarcodeSystem, Font } from "@/lib/domain/enums";

/**
 * The render model: one element of a request's `data` array, parsed.
 *
 * Ported from `agent/src/main/java/fi/natroutter/fenpos/markup/model/`, which is where this
 * shape was designed and where the ESC/POS renderer still consumes it. The difference on this
 * side is `sourceColumn`: it exists so an error can point at the exact character at fault, which
 * is the property that makes a `400` from this API worth reading.
 *
 * Deliberately not the same as the wire types in `lib/link/protocol.ts`. The wire carries no
 * source column, because by the time a job crosses the link every positional error has already
 * been raised and answered.
 */

/** A fully resolved style. Not a tag stack: a span can be rendered without looking at its neighbours. */
export interface SpanStyle {
	bold: boolean;
	/** Thickness: 0 for none, 1 or 2 for the two ESC/POS weights. */
	underline: 0 | 1 | 2;
	invert: boolean;
	widthMult: number;
	heightMult: number;
	font: Font;
}

/** Unstyled text: the state a line starts and ends in. */
export const PLAIN: SpanStyle = {
	bold: false,
	underline: 0,
	invert: false,
	widthMult: 1,
	heightMult: 1,
	font: "A",
};

/** A run of text sharing one style. */
export interface Span {
	text: string;
	style: SpanStyle;
	/**
	 * 1-based column in the original element where this run began.
	 *
	 * Exact only while the span is as the parser produced it: the parser starts a new span at
	 * every entity, so a span's characters are always contiguous in the source. After wrapping
	 * has split spans the value becomes approximate, which is acceptable because every error
	 * that reports a column is raised before wrapping runs.
	 */
	sourceColumn: number;
}

/**
 * A printer action that is not text.
 *
 * Directives occupy no columns and are invisible to wrapping, but most of them still consume
 * paper — a feed advances it, a rule prints across it, a symbol is a block of dots several lines
 * tall — so the line budget has to charge for them. A symbol's cost is not derivable from its
 * content, so it carries the measured `heightLines`; a cut and a drawer pulse carry no height at
 * all, because they genuinely move no paper.
 */
export type Directive =
	| { kind: "CUT"; mode: "FULL" | "PARTIAL" }
	| { kind: "FEED"; lines: number }
	/** A full-width rule, expanded to characters at compile time once the width is known. */
	| { kind: "RULE" }
	/** A QR code. `size` is the module size in dots, 1-16. */
	| { kind: "QR"; content: string; size: number; heightLines: number }
	/** A linear barcode in one of the printer's supported symbologies. */
	| { kind: "BARCODE"; system: BarcodeSystem; content: string; heightLines: number }
	/** A PDF417 stacked symbol. `errorLevel` is its error-correction level, 0-8. */
	| { kind: "PDF417"; content: string; errorLevel: number; heightLines: number }
	/**
	 * A cash drawer kick on pin 2 or 5.
	 *
	 * No `heightLines`, and not merely zero: the pulse is an electrical signal to a connected
	 * drawer, so unlike every other directive here it never touches the paper at all. That is
	 * also why it is the one directive allowed to share a line with text.
	 */
	| { kind: "DRAWER"; pin: 2 | 5 };

/** One parsed element. Alignment is a line property because ESC/POS justifies whole lines. */
export interface Line {
	align: Align;
	/**
	 * Whether this line is broken to the paper width.
	 *
	 * `null` means the element carried no wrap tag, and the device's `defaultWrap` decides. A
	 * line property for the same reason alignment is one: a half-wrapped line is not a thing.
	 */
	wrap: boolean | null;
	spans: Span[];
	directives: Directive[];
}

/**
 * Returns the 1-based source column of the character at an offset within a span.
 *
 * @param span the span
 * @param offset 0-based index into the span's text
 * @returns the corresponding column in the original element
 */
export function columnAt(span: Span, offset: number): number {
	return span.sourceColumn + offset;
}

/**
 * Returns the columns a line occupies when printed.
 *
 * A character's cost depends on its span's width multiplier, so this is not the text length.
 *
 * @param line the line to measure
 * @returns total printed columns
 */
export function lineColumns(line: Line): number {
	return line.spans.reduce((total, span) => total + span.text.length * span.style.widthMult, 0);
}

/**
 * Whether a line emits directives without advancing the paper.
 *
 * @param line the line to test
 * @returns true when it has no text
 */
export function isDirectiveOnly(line: Line): boolean {
	return line.spans.every((span) => span.text.length === 0);
}
