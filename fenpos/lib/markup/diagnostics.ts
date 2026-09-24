/**
 * Turns the compiler's positioned failures into ranges an editor can underline.
 *
 * **The compiler has always known which character was wrong; nothing showed it.** Every markup
 * refusal carries a line and, where the failure has a position at all, a column — that is the
 * property the whole API is built around. Until this existed those two numbers reached the author as
 * a sentence in the pane beside the editor, and reading it meant counting characters by eye.
 *
 * Nothing here decides what is wrong. The errors arrive already made, from the same compile the
 * paper preview runs, so an underline can never disagree with the verdict printed beside it.
 *
 * Deliberately free of CodeMirror, like the rest of this directory: the shape below is the editor's
 * `Diagnostic` in all but name, and `markup-language.ts` is where the two meet. That keeps the
 * arithmetic — which is all this is — testable without a DOM.
 */

/**
 * The most characters one diagnostic will underline.
 *
 * A bound rather than a measurement: a range runs to the first space, and a line with no spaces on
 * it — a long URL inside `<qr>`, a row of tags written without a break — would otherwise be
 * underlined end to end, which points at everything and therefore at nothing.
 */
export const MAX_MARKED_CHARS = 40;

/** A compiler failure, as much of it as a position needs. `PreviewError` satisfies this. */
export interface PositionedError {
	/** 1-based line of the document, or null for a failure that belongs to the request as a whole. */
	line: number | null;
	/** 1-based character within that line, or null when the failure has no position within it. */
	column: number | null;
	message: string;
}

/** One underlined range, in offsets from the start of the document. */
export interface MarkupDiagnostic {
	from: number;
	to: number;
	severity: "error";
	message: string;
}

/**
 * Places each error in the document.
 *
 * An error with no line is dropped rather than guessed at: `too_many_output_lines` and the raster
 * budget are properties of the whole request, and underlining line 1 for them would blame a line
 * that is not at fault. They still read perfectly well in the list beside the paper.
 *
 * A line the document no longer has is dropped too. The preview is debounced, so its answer
 * describes the document as it was a moment ago; anything still standing is mapped forward by
 * CodeMirror's own lint state as the author keeps typing.
 *
 * @param errors what the compile refused, in the order it reported them
 * @param source the document the compile was asked about
 * @returns one range per error that has somewhere to point, in the order given
 */
export function diagnosticsFor(errors: readonly PositionedError[], source: string): MarkupDiagnostic[] {
	const starts = lineStarts(source);
	const diagnostics: MarkupDiagnostic[] = [];

	for (const error of errors) {
		if (error.line === null || error.line < 1 || error.line > starts.length) {
			continue;
		}

		const start = starts[error.line - 1];
		const end = lineEnd(source, start);

		// No column means the line is all that is known. Underlining the whole of it says exactly
		// that, where a guess at a character would say something the compiler never claimed.
		if (error.column === null) {
			diagnostics.push({ from: start, to: end, severity: "error", message: error.message });
			continue;
		}

		const from = Math.min(start + Math.max(0, error.column - 1), end);
		diagnostics.push({ from, to: constructEnd(source, from, end), severity: "error", message: error.message });
	}

	return diagnostics;
}

/** The characters that close what they open, for a column standing on the opening one. */
const CLOSERS: Readonly<Record<string, string>> = { "<": ">", "{": "}" };

/**
 * Where the construct at an offset stops.
 *
 * Two rules, because the compiler points at two different kinds of thing. A column on a `<` or a `{`
 * is a whole tag or reference, and runs to the bracket that closes it. A column on anything else —
 * an attribute, an entity, a character a codepage lacks — runs to the next space **or to the next
 * `>`**, whichever comes first.
 *
 * That second stop is what keeps the underline inside the tag it belongs to. Without it
 * `<box width=101></box>` marked `width=101></box>`, which blames the closing tag for a number
 * written in the opening one.
 *
 * Bounded by {@link MAX_MARKED_CHARS} and by the line's own end, so a missing closer cannot run the
 * mark away down the document.
 */
function constructEnd(source: string, from: number, lineEnd: number): number {
	const limit = Math.min(lineEnd, from + MAX_MARKED_CHARS);

	const closer = CLOSERS[source[from]];
	if (closer !== undefined) {
		const closed = source.indexOf(closer, from + 1);
		if (closed >= 0 && closed < limit) {
			return closed + 1;
		}
	}

	let at = from;
	while (at < limit && !/\s/.test(source[at]) && source[at] !== ">") {
		at += 1;
	}
	// At least one character wherever the line has one to give, so a marker is never invisible; a
	// column at the very end of a line has nothing left and is reported as the empty range it is.
	return at === from ? Math.min(from + 1, lineEnd) : at;
}

/**
 * Where each line of the document begins.
 *
 * Counted on `\n` alone, and a `\r` left before one is part of the line rather than a separator.
 * That is what keeps the columns honest: the compiler is handed a document `normaliseSource` has
 * already stripped of carriage returns, so it counts lines the same way, while the editor may still
 * hold the Windows endings someone pasted in.
 */
function lineStarts(source: string): number[] {
	const starts = [0];
	for (let at = source.indexOf("\n"); at >= 0; at = source.indexOf("\n", at + 1)) {
		starts.push(at + 1);
	}
	return starts;
}

/** Where the line beginning at `start` ends, the newline excluded. */
function lineEnd(source: string, start: number): number {
	const at = source.indexOf("\n", start);
	const end = at === -1 ? source.length : at;
	return end > start && source[end - 1] === "\r" ? end - 1 : end;
}
