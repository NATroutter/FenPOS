import type { Line, Span, SpanStyle } from "@/lib/markup/model";

/**
 * Splits a line so it fits the paper width.
 *
 * **Wrapping works on individual characters, not on the line's text.** A character's cost in
 * columns depends on the width multiplier of the span it belongs to: under `<size=2>` each
 * character occupies two columns, so the same text has to wrap at half the paper width.
 * Measuring string length would overflow the paper on every enlarged line.
 *
 * Breaks are chosen greedily at the last space that still fits. A word longer than the whole
 * width is broken hard, since the alternative is a line that overflows.
 *
 * Ported from `LineWrapper.java`, whose tests are the specification.
 */

const SPACE = " ";

/** One character together with everything needed to place and re-assemble it. */
interface Cell {
	character: string;
	style: SpanStyle;
	/** Where it came from in the original element. */
	sourceColumn: number;
}

/**
 * Wraps a line to the given width.
 *
 * Directives are attached to the final fragment only: a cut repeated once per fragment would
 * sever the paper in the middle of the receipt.
 *
 * @param line the line to wrap
 * @param columns printable columns at normal character width; must be at least 1
 * @returns one or more lines in printing order; a line with no text is returned unchanged
 * @throws RangeError if `columns` is below 1
 */
export function wrapLine(line: Line, columns: number): Line[] {
	if (columns < 1) {
		throw new RangeError(`columns must be at least 1, got ${columns}`);
	}
	if (line.spans.length === 0) {
		return [line];
	}

	const rows = layOut(flatten(line), columns);
	return toLines(rows, line);
}

/** Expands the line's spans into one entry per character, carrying its style forward. */
function flatten(line: Line): Cell[] {
	const cells: Cell[] = [];
	for (const span of line.spans) {
		for (let offset = 0; offset < span.text.length; offset++) {
			cells.push({
				character: span.text[offset],
				style: span.style,
				sourceColumn: span.sourceColumn + offset,
			});
		}
	}
	return cells;
}

/**
 * Greedily assigns characters to rows.
 *
 * The loop deliberately re-examines the current character after a break rather than advancing,
 * so a character that triggered a break is placed on the new row instead of being lost.
 */
function layOut(cells: Cell[], columns: number): Cell[][] {
	const rows: Cell[][] = [];
	let row: Cell[] = [];
	let width = 0;
	let lastSpace = -1;

	let index = 0;
	while (index < cells.length) {
		const cell = cells[index];

		// Whitespace left over from a break would indent the continuation.
		if (row.length === 0 && rows.length > 0 && isSpace(cell)) {
			index++;
			continue;
		}

		if (isSpace(cell)) {
			if (width + cost(cell) > columns) {
				// The space itself is the break point, so it is consumed rather than carried to
				// the next row.
				rows.push(row);
				row = [];
				width = 0;
				lastSpace = -1;
				index++;
				continue;
			}
			lastSpace = row.length;
		} else if (row.length > 0 && width + cost(cell) > columns) {
			if (lastSpace >= 0) {
				// Everything after the last space is an unfinished word: move it down.
				const carried = row.slice(lastSpace + 1);
				rows.push(row.slice(0, lastSpace));
				row = carried;
				width = widthOf(carried);
			} else {
				// A word wider than the paper: break it rather than overflow.
				rows.push(row);
				row = [];
				width = 0;
			}
			lastSpace = -1;
			continue;
		}

		row.push(cell);
		width += cost(cell);
		index++;
	}
	rows.push(row);

	return trim(rows);
}

/**
 * Removes trailing spaces from every row, then drops rows left empty at the end.
 *
 * Trailing spaces are invisible on paper but consume columns, so keeping them would push a
 * following word onto a new line for no reason. At least one row always survives, so a line of
 * nothing but spaces still prints as one blank line.
 */
function trim(rows: Cell[][]): Cell[][] {
	for (const row of rows) {
		while (row.length > 0 && isSpace(row[row.length - 1])) {
			row.pop();
		}
	}
	while (rows.length > 1 && rows[rows.length - 1].length === 0) {
		rows.pop();
	}
	return rows;
}

/** Rebuilds lines from rows, merging neighbouring characters that share a style. */
function toLines(rows: Cell[][], source: Line): Line[] {
	return rows.map((row, index) => ({
		align: source.align,
		spans: toSpans(row),
		directives: index === rows.length - 1 ? source.directives : [],
	}));
}

function toSpans(row: Cell[]): Span[] {
	const spans: Span[] = [];
	let text = "";
	let style: SpanStyle | null = null;
	let startColumn = 1;

	for (const cell of row) {
		if (style !== null && !sameStyle(style, cell.style)) {
			spans.push({ text, style, sourceColumn: startColumn });
			text = "";
		}
		if (text.length === 0) {
			style = cell.style;
			startColumn = cell.sourceColumn;
		}
		text += cell.character;
	}
	if (text.length > 0 && style !== null) {
		spans.push({ text, style, sourceColumn: startColumn });
	}
	return spans;
}

/**
 * Compares two styles by value.
 *
 * The Java model is a record, so equality there is structural and free. Here it has to be
 * spelled out, and it must stay exhaustive: a field left out would silently merge two spans that
 * print differently.
 */
function sameStyle(left: SpanStyle, right: SpanStyle): boolean {
	return (
		left.bold === right.bold &&
		left.underline === right.underline &&
		left.invert === right.invert &&
		left.widthMult === right.widthMult &&
		left.heightMult === right.heightMult &&
		left.font === right.font
	);
}

/** Returns the columns a character occupies when printed. */
function cost(cell: Cell): number {
	return cell.style.widthMult;
}

function isSpace(cell: Cell): boolean {
	return cell.character === SPACE;
}

function widthOf(cells: Cell[]): number {
	return cells.reduce((total, cell) => total + cost(cell), 0);
}
