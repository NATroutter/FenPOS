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
	 * Exact for the span's *first* character while the span is as the parser produced it: the parser
	 * starts a new span at every entity, so a span's characters are always contiguous in the source.
	 * After wrapping has split spans the value becomes approximate, which is acceptable because every
	 * error that reports a column is raised before wrapping runs.
	 *
	 * Whether the later characters have exact columns too depends on {@link Span.expandedFrom}, and
	 * that is what {@link columnAt} exists to decide — never read this field and add an offset to it
	 * by hand.
	 */
	sourceColumn: number;
	/**
	 * The variable name whose value this span holds, when it was substituted rather than typed.
	 *
	 * Absent for every span the author actually wrote, which is nearly all of them. Present only for
	 * `{name}` substitution, and present because such a span is the one place where a character's
	 * column cannot be computed: `{x}` occupies three columns of source and may produce two hundred
	 * characters of output, so counting forward from `sourceColumn` runs off the end of an element
	 * that was never that long. An entity is not marked — `&amp;` produces exactly one character, so
	 * its only offset is zero and the arithmetic cannot overshoot.
	 *
	 * The name travels with it so a failure inside a substituted value can still be attributed:
	 * `charset.ts` puts it in the error's `detail`, which is the caller's replacement for a column
	 * that no longer means anything.
	 */
	expandedFrom?: string;
}

/**
 * A pad, waiting for the column count that decides how wide it is.
 *
 * The only member of this model that describes an instruction rather than something printed:
 * `resolveFills` replaces it with the span it stands for, and every line from the wrapper onward
 * carries none.
 */
export interface Fill {
	/**
	 * How many spans precede it.
	 *
	 * An index into a list that a later stage rewrites. `validateCharset` drops a span stripped to
	 * nothing and adjusts this to match; any stage inserted between the parser and the resolver
	 * inherits that obligation.
	 */
	afterSpans: number;
	/** The character to repeat. Exactly one code point; a space unless the tag said otherwise. */
	character: string;
	style: SpanStyle;
	sourceColumn: number;
}

/**
 * A printer action that is not text.
 *
 * Directives occupy no columns and are invisible to wrapping, but most of them still consume
 * paper — a feed advances it, a rule prints across it, a symbol is a block of dots several lines
 * tall — so the line budget has to charge for them. A symbol's cost is not derivable from its
 * content, so it carries its measured size; a cut and a drawer pulse carry no size at all, because
 * they genuinely move no paper. An image is the exception in both directions: it consumes paper and
 * still carries no size, because measuring it needs the paper's width and the image's own
 * dimensions, neither of which the parser can reach. See `IMAGE` below.
 *
 * `heightLines` and `widthDots` are both compile-time figures and neither crosses the wire: the
 * agent's own library measures a symbol when it draws it. They exist so that the line budget and
 * the paper preview describe the same symbol — one charges the height, the other draws the symbol
 * at that height and at its true share of the paper's width.
 *
 * `sourceColumn` travels with them for the same reason and one step further. Whether a symbol fits
 * the paper is not knowable in the parser — the paper's width belongs to the device — so the
 * refusal happens in the compiler, by which point the element text is gone. The column is what lets
 * that refusal still point at the tag the caller has to change.
 */
export type Directive =
	| { kind: "CUT"; mode: "FULL" | "PARTIAL" }
	| { kind: "FEED"; lines: number }
	/** A full-width rule, expanded to characters at compile time once the width is known. */
	| { kind: "RULE" }
	/** A QR code. `size` is the module size in dots, 1-16. */
	| { kind: "QR"; content: string; size: number; heightLines: number; widthDots: number; sourceColumn: number }
	/** A linear barcode in one of the printer's supported symbologies. */
	| {
			kind: "BARCODE";
			system: BarcodeSystem;
			content: string;
			heightLines: number;
			widthDots: number;
			sourceColumn: number;
	  }
	/**
	 * A PDF417 stacked symbol. `errorLevel` is its error-correction level, 0-8.
	 *
	 * `columns` is the exception to the note above: it is a compile-time figure that *does* cross
	 * the wire. `GS ( k` function 65 reads a column count of zero as "printer decides", so a symbol
	 * sent without one is laid out by the firmware while the budget was charged against the layout
	 * the server measured. Carrying the number is what makes the two the same symbol.
	 */
	| {
			kind: "PDF417";
			content: string;
			errorLevel: number;
			columns: number;
			heightLines: number;
			widthDots: number;
			sourceColumn: number;
	  }
	/**
	 * A cash drawer kick on pin 2 or 5.
	 *
	 * No `heightLines`, and not merely zero: the pulse is an electrical signal to a connected
	 * drawer, so unlike every other directive here it never touches the paper at all. That is
	 * also why it is the one directive allowed to share a line with text.
	 */
	| { kind: "DRAWER"; pin: 2 | 5 }
	/**
	 * A stored image or an `http(s)` URL, printed at `widthPercent` of the paper's width.
	 *
	 * The one paper-consuming directive carrying no measurement, and it is the parser that cannot
	 * supply one. A symbol's height follows from its content, which the parser holds; an image's
	 * height follows from the image's own dimensions and the device's dot width, and the first of
	 * those is a database row or an HTTP response. `parseMarkup` is synchronous and knows nothing
	 * of either, so the height is settled later — see `imageGeometry` in `lib/markup/images.ts` and
	 * the `images` field of `CompileSettings`, which is where the compiler picks it up.
	 *
	 * The width is a percentage rather than a dot count because one install can have both 80mm and
	 * 58mm printers behind a single agent. A dot count would print a logo that fits one of them and
	 * overruns the other, which is the very problem storing the source image exists to avoid.
	 */
	| { kind: "IMAGE"; ref: string; widthPercent: number };

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
	/**
	 * Pads to be expanded once the device's column count is known.
	 *
	 * Empty from `resolveFills` onward, which is the second half of a line's life: the wrapper, the
	 * wire and the agent never see one.
	 */
	fills: Fill[];
	directives: Directive[];
}

/**
 * Returns the 1-based source column of the character at an offset within a span.
 *
 * **A substituted span reports its reference's column for every character it holds**, rather than
 * counting forward through characters the author never wrote. `{x}` is three columns of source; a
 * value of `Kahvi ☕` is seven characters of output. Adding the offset would report column 7 for an
 * element only three columns long — a position that does not exist, handed to someone told this API
 * points at the exact character at fault. Pointing at the reference is the honest answer: it is
 * where the caller has to look, and it is a column their element actually has. What character
 * inside the value went wrong is carried in the error's `detail` instead, by way of
 * {@link Span.expandedFrom}.
 *
 * @param span the span
 * @param offset 0-based index into the span's text
 * @returns the corresponding column in the original element
 */
export function columnAt(span: Span, offset: number): number {
	return span.expandedFrom === undefined ? span.sourceColumn + offset : span.sourceColumn;
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
