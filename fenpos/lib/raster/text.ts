import type { ImageRaster } from "@/lib/assets/dither";
import type { Align, Codepage, UnsupportedPolicy } from "@/lib/domain/enums";
import { UnsupportedCharacterError } from "@/lib/markup/errors";
import { share } from "@/lib/markup/fill";
import { PLAIN, type SpanStyle } from "@/lib/markup/model";
import type { Canvas } from "@/lib/raster/canvas";
import type { Typeface } from "@/lib/raster/fonts";
import { cachedGlyph } from "@/lib/raster/glyph-cache";
import type { GlyphBitmap } from "@/lib/raster/glyphs";

/**
 * The inline flow: styled text, fills and inline images measured, broken and painted in dots.
 *
 * **Why this repeats work the printer already does.** A line of native text is columns — the device
 * owns the font, so the encoder counts characters and the printer places them. A line drawn into a
 * raster has no columns at all: an outline is scaled to whatever em size the face asks for and every
 * position is a dot. The two have to agree anyway, because a drawn line sits on the same paper as
 * the native ones above and below it, so everything here is the column arithmetic of a printed line
 * restated in dots — the same greedy break at a space, the same remainder rule for fills, the same
 * three alignments.
 *
 * Measuring and painting are split for the same reason a printed line is: what a row costs has to be
 * known before anything is drawn, because the row above cannot be placed until the row below has
 * said how tall it is.
 */

/** A stretch of text in one style. `column` is where its first character sits in the source line. */
export interface InlineRun {
	kind: "run";
	text: string;
	style: SpanStyle;
	column: number;
	/** The variable whose value this run holds, when it was substituted rather than typed. */
	expandedFrom?: string;
}

/** A `<fill>`, which takes whatever width is left over once everything else on its row is measured. */
export interface InlineFill {
	kind: "fill";
	character: string;
	style: SpanStyle;
	/** Where the tag was written in the source line, for naming a character the face cannot draw. */
	column: number;
}

/** An image already dithered to the width it will occupy. */
export interface InlineImage {
	kind: "image";
	raster: ImageRaster;
}

/** A checkbox, drawn at the size the style around it prints. */
export interface InlineCheck {
	kind: "check";
	checked: boolean;
	style: SpanStyle;
}

export type InlineItem = InlineRun | InlineFill | InlineImage | InlineCheck;

/** What the flow needs from its surroundings: which font a style selects, and what to do with a gap in it. */
export interface TextContext {
	/** The built-in font a style names, or a configured face at the style's size. */
	typeface(style: SpanStyle): Typeface;
	onUnsupported: UnsupportedPolicy;
	/** Only ever read for the error the `REJECT` policy raises. */
	codepage: Codepage;
}

/** One placed item: where it sits across the row, how big it is, and how to draw it. */
export interface Cell {
	/** Offset from the left of the row, after alignment. */
	x: number;
	width: number;
	height: number;
	/** Draws the cell with its top-left corner at (x, y). */
	paint(canvas: Canvas, x: number, y: number): void;
}

/** One laid-out row. `width` is what the cells actually occupy, which is not the width they were given. */
export interface TextRow {
	width: number;
	height: number;
	cells: Cell[];
}

/** The character the `REPLACE` policy stands in for anything the face lacks. */
const REPLACEMENT = "?";

/** How far below the baseline an underline is ruled, before the height multiplier is applied. */
const UNDERLINE_DROP = 2;

/** One measured glyph, occupying its advance rather than its ink. */
interface GlyphAtom {
	kind: "glyph";
	glyph: GlyphBitmap;
	typeface: Typeface;
	style: SpanStyle;
	width: number;
	height: number;
	space: boolean;
}

/**
 * One fill. `width` is zero until the row it landed on is known, because a fill takes what that row
 * has left rather than a width of its own.
 */
interface FillAtom {
	kind: "fill";
	glyph: GlyphBitmap | null;
	typeface: Typeface;
	style: SpanStyle;
	/** What one repetition costs: the character's advance at this style's width multiplier. */
	cellWidth: number;
	width: number;
	height: number;
	space: false;
}

interface ImageAtom {
	kind: "image";
	raster: ImageRaster;
	width: number;
	height: number;
	space: false;
}

interface CheckAtom {
	kind: "check";
	checked: boolean;
	/** The square's own side, which is smaller than the cell it is centred in. */
	side: number;
	stroke: number;
	width: number;
	height: number;
	space: false;
}

type Atom = GlyphAtom | FillAtom | ImageAtom | CheckAtom;

/**
 * Lays out a line's inline items into rows of placed cells.
 *
 * @param items the line's runs, fills and images, in order
 * @param availableWidth the dots a row may occupy
 * @param wrap whether a row too long for the width is broken, or left to overflow
 * @param align how a row is placed in the width it did not use
 * @param context the fonts to draw with and what to do with a character none of them has
 * @param indent dots every row but the first begins at, which is the hanging indent of a list entry;
 *        clamped to leave a dot to draw in
 * @returns one row per printed line, always at least one
 * @throws UnsupportedCharacterError under the `REJECT` policy, when the face has no such glyph
 */
export function layoutText(
	items: InlineItem[],
	availableWidth: number,
	wrap: boolean,
	align: Align,
	context: TextContext,
	indent = 0,
): TextRow[] {
	const blank = blankHeight(items, context);
	// The same clamp the printed-line wrapper applies, and for the same reason: how deep a list nests
	// is the author's and how wide the paper is belongs to the device, so the two can disagree.
	const hanging = Math.min(indent, Math.max(0, availableWidth - 1));
	return breakRows(measure(items, context), availableWidth, wrap, hanging).map((atoms, index) => {
		const offset = index === 0 ? 0 : hanging;
		return buildRow(trimTrailingSpaces(atoms), availableWidth - offset, align, blank, offset);
	});
}

/**
 * Paints rows one under another.
 *
 * @param canvas the surface to draw on; everything clips to it
 * @param rows the rows to paint, in order
 * @param x the left edge of the text
 * @param y the top of the first row
 * @returns the dots consumed, which is the sum of the row heights
 */
export function paintRows(canvas: Canvas, rows: TextRow[], x: number, y: number): number {
	let top = y;
	for (const row of rows) {
		for (const cell of row.cells) {
			// Floored: a cell an odd number of dots shorter than its row sits one dot high rather than
			// straddling a dot boundary it cannot land on.
			cell.paint(canvas, x + cell.x, top + Math.floor((row.height - cell.height) / 2));
		}
		top += row.height;
	}
	return top - y;
}

/** The dots a laid-out text occupies from the top of its first row to the bottom of its last. */
export function textHeight(rows: TextRow[]): number {
	return rows.reduce((total, row) => total + row.height, 0);
}

/**
 * The height of a row with nothing on it.
 *
 * A row can come out empty when every character on it was stripped, and it still occupies a line of
 * paper. The first styled item decides how tall that line is, since a blank row has no cell to ask.
 */
function blankHeight(items: InlineItem[], context: TextContext): number {
	for (const item of items) {
		if (item.kind !== "image" && item.kind !== "check") {
			return context.typeface(item.style).cellHeight;
		}
	}
	return context.typeface(PLAIN).cellHeight;
}

/** Turns items into one atom per code point, image and fill, resolving anything the face lacks. */
function measure(items: InlineItem[], context: TextContext): Atom[] {
	const atoms: Atom[] = [];

	for (const item of items) {
		if (item.kind === "check") {
			atoms.push(checkAtom(item, context));
			continue;
		}
		if (item.kind === "image") {
			atoms.push({
				kind: "image",
				raster: item.raster,
				width: item.raster.widthDots,
				height: item.raster.heightDots,
				space: false,
			});
			continue;
		}

		const typeface = context.typeface(item.style);
		const height = typeface.cellHeight * item.style.heightMult;

		if (item.kind === "fill") {
			// The character is one the caller wrote, at a column their line really has, so it answers to
			// the unsupported policy exactly as a run's does. Under `STRIP` there is then nothing to
			// stamp, and the fill buys nothing and leaves its slack blank — the same outcome as a budget
			// too small for one repetition.
			const glyph =
				cachedGlyph(typeface.face, codePointOf(item.character), typeface.emDots) ??
				substitute(item.character, item.column, undefined, typeface, context);
			atoms.push({
				kind: "fill",
				glyph,
				typeface,
				style: item.style,
				cellWidth: (glyph?.advance ?? 0) * item.style.widthMult,
				width: 0,
				height,
				space: false,
			});
			continue;
		}

		// Counted in code units rather than code points, so the column matches the one the charset
		// pass would have reported for the same character.
		let offset = 0;
		for (const character of item.text) {
			// A substituted run reports its reference's column for every character it holds: counting
			// forward through characters the author never wrote names a column their line does not have.
			const column = item.expandedFrom === undefined ? item.column + offset : item.column;
			const glyph =
				cachedGlyph(typeface.face, codePointOf(character), typeface.emDots) ??
				substitute(character, column, item.expandedFrom, typeface, context);
			if (glyph !== null) {
				atoms.push({
					kind: "glyph",
					glyph,
					typeface,
					style: item.style,
					width: glyph.advance * item.style.widthMult,
					height,
					space: character === " ",
				});
			}
			offset += character.length;
		}
	}

	return atoms;
}

/**
 * Applies the unsupported-character policy to a character the face has no glyph for.
 *
 * @param character the character the face lacks
 * @param column where to say it was written
 * @param expandedFrom the variable whose value carried it, or undefined when the caller typed it
 * @param typeface the face that lacks it, which is also the one the replacement is drawn from
 * @param context the policy and the codepage the refusal names
 * @returns the glyph to draw instead, or null when the character is to be dropped
 * @throws UnsupportedCharacterError under the `REJECT` policy
 */
function substitute(
	character: string,
	column: number,
	expandedFrom: string | undefined,
	typeface: Typeface,
	context: TextContext,
): GlyphBitmap | null {
	if (context.onUnsupported === "REJECT") {
		throw new UnsupportedCharacterError(character, column, context.codepage, expandedFrom ?? null);
	}
	if (context.onUnsupported === "STRIP") {
		return null;
	}
	return cachedGlyph(typeface.face, codePointOf(REPLACEMENT), typeface.emDots);
}

function codePointOf(character: string): number {
	return character.codePointAt(0) ?? 0;
}

/**
 * Breaks atoms into rows, greedily.
 *
 * Fills are weightless here: a fill is what is left over after the row is settled, so letting it
 * claim width while the row is still being filled would break the row at the fill every time.
 *
 * Every row but the first is broken to `availableWidth - indent`, because its caller places it that
 * far in. Read from `rows.length` on each pass rather than fixed once, so the width narrows the moment
 * the first row is pushed.
 *
 * @returns one array of atoms per row, always at least one
 */
function breakRows(atoms: Atom[], availableWidth: number, wrap: boolean, indent: number): Atom[][] {
	if (!wrap) {
		return [atoms];
	}

	const rows: Atom[][] = [];
	let current: Atom[] = [];
	let width = 0;
	const available = (): number => (rows.length === 0 ? availableWidth : availableWidth - indent);
	/** Index in `current` of the last space, or -1 while the row holds none. */
	let lastSpace = -1;
	/** Whether the empty row being filled was opened by a break rather than by the start of the line. */
	let broken = false;

	const flush = (upTo: number, resumeFrom: number): void => {
		rows.push(current.slice(0, upTo));
		current = current.slice(resumeFrom);
		width = breakingWidth(current);
		lastSpace = -1;
		broken = true;
	};

	for (const atom of atoms) {
		const cost = atom.kind === "fill" ? 0 : atom.width;

		// A break swallows the whole run of spaces at the boundary, not just the first: the row below
		// opens at the next word rather than however many spaces into it the author happened to type.
		// The line's own leading spaces are indentation the author wrote and are not at a boundary,
		// which is what `broken` tells apart.
		if (atom.space && current.length === 0 && broken) {
			continue;
		}

		if (atom.space && current.length > 0 && width + cost > available()) {
			// The space that does not fit is itself the break, and a break drops its space.
			flush(current.length, current.length);
			continue;
		}

		// A loop rather than a branch: breaking at a space can leave a tail that still does not fit
		// with this atom beside it, and that tail is then a word wider than the row and broken by glyph.
		while (current.length > 0 && width + cost > available()) {
			if (lastSpace >= 0) {
				flush(lastSpace, lastSpace + 1);
			} else {
				flush(current.length, current.length);
			}
		}

		// A space that opens a row — the line's own indentation, since a break's spaces never get
		// this far — is not a break candidate: breaking there would hand the row above nothing at all
		// and leave the word below exactly where it already is.
		if (atom.space && current.length > 0) {
			lastSpace = current.length;
		}
		current.push(atom);
		width += cost;
	}

	// The row left over, unless the last atom was a break that emptied it — a line ending in a space
	// ends on the row that space was dropped from, not on a blank one below it.
	if (current.length > 0 || rows.length === 0) {
		rows.push(current);
	}
	return rows;
}

/** What a row of atoms costs while it is being broken, with fills still weightless. */
function breakingWidth(atoms: Atom[]): number {
	return atoms.reduce((total, atom) => total + (atom.kind === "fill" ? 0 : atom.width), 0);
}

/**
 * Drops the spaces at the end of a row.
 *
 * A row's width is meant to measure what is printed on it, and a space at the edge prints nothing:
 * leaving it in would push a centred row off centre and shorten every fill on it.
 */
function trimTrailingSpaces(atoms: Atom[]): Atom[] {
	let end = atoms.length;
	while (end > 0 && atoms[end - 1].space) {
		end--;
	}
	return end === atoms.length ? atoms : atoms.slice(0, end);
}

/**
 * Spends the row's fills, then places every atom as a cell.
 *
 * `availableWidth` is what this row has rather than what the line has, and `offset` is where it
 * begins: a hanging indent takes dots off the front of a continuation row, so the row is justified
 * within what is left and every cell then shifted past the indent. The row's own `width` counts the
 * indent, because it measures how far across the flow the row reaches.
 */
function buildRow(atoms: Atom[], availableWidth: number, align: Align, blank: number, offset = 0): TextRow {
	spendFills(atoms, availableWidth);

	let content = 0;
	let height = atoms.length === 0 ? blank : 0;
	for (const atom of atoms) {
		content += atom.width;
		height = Math.max(height, atom.height);
	}

	let x = offset;
	if (align === "CENTER") {
		x += Math.floor((availableWidth - content) / 2);
	} else if (align === "RIGHT") {
		x += availableWidth - content;
	}

	const cells: Cell[] = [];
	for (const atom of atoms) {
		cells.push({ x, width: atom.width, height: atom.height, paint: painterFor(atom) });
		x += atom.width;
	}

	return { width: offset + content, height, cells };
}

/**
 * Gives every fill on a row its width.
 *
 * The slack is split the way a printed line splits its columns, then each share is spent in whole
 * repetitions: a fill inside an enlarged span can leave up to one cell's worth of its share unspent,
 * and that remainder stays blank rather than being smeared across the neighbouring fills.
 */
function spendFills(atoms: Atom[], availableWidth: number): void {
	const fills = atoms.filter((atom): atom is FillAtom => atom.kind === "fill");
	if (fills.length === 0) {
		return;
	}

	const content = atoms.reduce((total, atom) => total + (atom.kind === "fill" ? 0 : atom.width), 0);
	const budgets = share(Math.max(0, availableWidth - content), fills.length);
	for (let index = 0; index < fills.length; index++) {
		const fill = fills[index];
		fill.width = fill.cellWidth > 0 ? Math.floor(budgets[index] / fill.cellWidth) * fill.cellWidth : 0;
	}
}

/**
 * How much of a line a checkbox takes up, as a share of the cell it is drawn in.
 *
 * Less than the whole cell, because a cell is sized for an ascender over a descender and a square
 * drawn to that height towers over the lower-case letters beside it. Three quarters is about the
 * height of a capital, which is what the eye reads a checkbox as lining up with.
 */
const CHECK_SIDE = 0.72;

/** The gap either side of the square, so it does not touch the word after it. */
const CHECK_GAP = 0.14;

/**
 * Measures a checkbox against the style it was written in.
 *
 * The atom is as tall as a full cell even though the square is not, so that the row it sits in is no
 * taller for having a checkbox on it. {@link paintRows} centres every cell in its row and
 * {@link paintCheck} centres the square in the cell, which between them are what put the box on the
 * same middle as the words: two centrings rather than a baseline, because a drawn square has no
 * baseline to sit on.
 */
function checkAtom(item: InlineCheck, context: TextContext): CheckAtom {
	const typeface = context.typeface(item.style);
	const height = typeface.cellHeight * item.style.heightMult;
	const side = Math.max(3, Math.round(height * CHECK_SIDE));
	return {
		kind: "check",
		checked: item.checked,
		side,
		// Two dots from double height up, so an enlarged checkbox reads as heavier rather than as the
		// same hairline stretched around a bigger square.
		stroke: item.style.heightMult > 1 ? 2 : 1,
		width: side + 2 * Math.max(1, Math.round(side * CHECK_GAP)),
		height,
		space: false,
	};
}

/**
 * Draws the square, and the cross inside it when it is ticked.
 *
 * The cross is inset from the frame by its own stroke so the two never touch — a cross drawn corner
 * to corner reads as a filled box at this size, which is the opposite of what a tick means.
 *
 * @param x the left of the whole atom, gap included
 * @param y the top of the atom, which is a full cell tall
 */
function paintCheck(canvas: Canvas, atom: CheckAtom, x: number, y: number): void {
	const left = x + Math.floor((atom.width - atom.side) / 2);
	const top = y + Math.floor((atom.height - atom.side) / 2);
	canvas.rect(left, top, atom.side, atom.side, atom.stroke);

	if (!atom.checked) {
		return;
	}
	const inset = atom.stroke + Math.max(1, Math.round(atom.side * 0.18));
	const first = left + inset;
	const last = left + atom.side - 1 - inset;
	const upper = top + inset;
	const lower = top + atom.side - 1 - inset;
	for (let step = 0; step < atom.stroke; step++) {
		canvas.line(first + step, upper, last, lower - step);
		canvas.line(first, upper + step, last - step, lower);
		canvas.line(first + step, lower, last, upper + step);
		canvas.line(first, lower - step, last - step, upper);
	}
}
/** Builds the closure a cell paints itself with. Each one holds its own atom, already fully measured. */
function painterFor(atom: Atom): (canvas: Canvas, x: number, y: number) => void {
	if (atom.kind === "check") {
		return (canvas, x, y) => {
			paintCheck(canvas, atom, x, y);
		};
	}

	if (atom.kind === "image") {
		return (canvas, x, y) => {
			canvas.blit(atom.raster, x, y);
		};
	}

	if (atom.kind === "glyph") {
		return (canvas, x, y) => {
			paintGlyph(canvas, atom.glyph, x, y, atom.style, atom.typeface);
			decorate(canvas, x, y, atom.width, atom.height, atom.style, atom.typeface);
		};
	}

	return (canvas, x, y) => {
		if (atom.glyph !== null && atom.cellWidth > 0) {
			for (let at = 0; at + atom.cellWidth <= atom.width; at += atom.cellWidth) {
				paintGlyph(canvas, atom.glyph, x + at, y, atom.style, atom.typeface);
			}
		}
		decorate(canvas, x, y, atom.width, atom.height, atom.style, atom.typeface);
	};
}

/**
 * Draws one glyph into a cell whose top-left corner is (x, y).
 *
 * The multipliers scale by repetition rather than by resampling: a dot becomes a block of dots, with
 * no smoothing, because the printer has one ink level and a half-lit dot is not one of them.
 */
function paintGlyph(
	canvas: Canvas,
	glyph: GlyphBitmap,
	x: number,
	y: number,
	style: SpanStyle,
	typeface: Typeface,
): void {
	const baseline = y + typeface.ascent * style.heightMult;

	for (let gy = 0; gy < glyph.height; gy++) {
		for (let gx = 0; gx < glyph.width; gx++) {
			if (glyph.bits[gy * glyph.width + gx] === 0) {
				continue;
			}
			const left = x + (glyph.left + gx) * style.widthMult;
			const top = baseline + (glyph.top + gy) * style.heightMult;
			for (let dy = 0; dy < style.heightMult; dy++) {
				for (let dx = 0; dx < style.widthMult; dx++) {
					canvas.set(left + dx, top + dy);
					// Bold is the same glyph again one dot to the right, which is how the printer's own
					// emphasised mode thickens a stroke. One dot, not one multiplied cell: the stroke is
					// meant to gain weight, not to blur by however much the text was enlarged.
					if (style.bold) {
						canvas.set(left + dx + 1, top + dy);
					}
				}
			}
		}
	}
}

/** Rules the underline and flips the cell, in that order: an inverted cell inverts its own underline. */
function decorate(
	canvas: Canvas,
	x: number,
	y: number,
	width: number,
	height: number,
	style: SpanStyle,
	typeface: Typeface,
): void {
	if (style.underline > 0) {
		canvas.hLine(x, y + (typeface.ascent + UNDERLINE_DROP) * style.heightMult, width, style.underline);
	}
	if (style.invert) {
		canvas.invert(x, y, width, height);
	}
}
