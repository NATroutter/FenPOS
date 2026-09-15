import { type Font, type PathCommand, parse as parseFont } from "opentype.js";

/** A parsed font. `id` keys the glyph cache; for a stored font it is the asset id and update time. */
export interface FontFace {
	id: string;
	font: Font;
}

export interface GlyphBitmap {
	width: number;
	height: number;
	left: number;
	top: number;
	advance: number;
	bits: Uint8Array;
}

export class InvalidFontError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidFontError";
	}
}

/**
 * The most a face may stand, or reach across, in ems.
 *
 * A face is scaled by its em, so every dot it costs is an outline coordinate divided by
 * `unitsPerEm`. A font that declares a small em and then carries coordinates at the far end of the
 * signed short range claims a glyph thousands of ems tall, and nothing downstream questions it: the
 * rasterizer would size a bitmap from the outline it was handed, and a typeface would take a cell
 * height from the ascender and descender. Four ems is far past anything a real face needs — a
 * swash, an accent stack and a descender together stay inside two — and well short of the sizes
 * that turn a glyph into an allocation the process cannot make.
 */
const MAX_EM_SPAN = 4;

/** Dots allowed past the bound before a rasterized glyph is treated as missing rather than drawn. */
const GLYPH_MARGIN_DOTS = 8;

/**
 * Parses TTF or OTF bytes.
 *
 * Anything opentype.js cannot read, a font with no glyphs, and a font whose own metrics say its
 * outlines run far outside its em are all refused. The last of those is not a matter of taste: the
 * metrics are the only thing that says how large a glyph of this face is about to be rasterized,
 * and they are read from the file rather than from anything this process decided.
 */
export function parseFace(id: string, bytes: Buffer): FontFace {
	let font: Font;
	try {
		font = parseFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	} catch (error) {
		throw new InvalidFontError(error instanceof Error ? error.message : "unreadable font");
	}
	if (font.numGlyphs < 2 || font.unitsPerEm < 16) {
		throw new InvalidFontError("the font has no usable glyphs");
	}
	requireSaneOutlines(font);
	return { id, font };
}

/** Refuses a face whose line height or outline box runs past {@link MAX_EM_SPAN} of its own em. */
function requireSaneOutlines(font: Font): void {
	const em = font.unitsPerEm;
	const bound = MAX_EM_SPAN * em;
	const head = font.tables.head as { xMin?: number; xMax?: number; yMin?: number; yMax?: number } | undefined;
	const spans = [
		font.ascender - font.descender,
		(head?.yMax ?? 0) - (head?.yMin ?? 0),
		(head?.xMax ?? 0) - (head?.xMin ?? 0),
	];
	if (spans.some((span) => span > bound)) {
		throw new InvalidFontError("the font's outlines run far outside its em");
	}
}

export function hasGlyph(face: FontFace, codepoint: number): boolean {
	return face.font.charToGlyphIndex(String.fromCodePoint(codepoint)) > 0;
}

/** A line segment of a flattened outline. */
interface Edge {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

const CURVE_STEPS = 8;

/**
 * Renders one glyph at an em size in dots by scanline even-odd fill, with no anti-aliasing.
 *
 * The outline is flattened to edges, then for every dot row the crossings at the row's centre
 * are paired off: between an odd and the next even crossing is ink. That is even-odd fill,
 * which is what a counter needs to come out hollow whichever way the contours wind.
 *
 * A glyph whose flattened outline is far larger than the em it was asked for is treated as missing
 * rather than drawn. {@link parseFace} reads the metrics and refuses a face that declares outlines
 * like that, but the metrics are only a declaration: this is measured off the outline itself, after
 * it has been scaled, and it is what stands between one malformed glyph and a bitmap the process
 * cannot allocate.
 */
export function rasterizeGlyph(face: FontFace, codepoint: number, emDots: number): GlyphBitmap | null {
	if (!hasGlyph(face, codepoint)) {
		return null;
	}
	const glyph = face.font.charToGlyph(String.fromCodePoint(codepoint));
	const advance = Math.round(((glyph.advanceWidth ?? 0) / face.font.unitsPerEm) * emDots);
	const path = glyph.getPath(0, 0, emDots);
	const edges = flatten(path.commands);
	if (edges.length === 0) {
		return { width: 0, height: 0, left: 0, top: 0, advance, bits: new Uint8Array(0) };
	}

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const edge of edges) {
		minX = Math.min(minX, edge.x0, edge.x1);
		maxX = Math.max(maxX, edge.x0, edge.x1);
		minY = Math.min(minY, edge.y0, edge.y1);
		maxY = Math.max(maxY, edge.y0, edge.y1);
	}
	const left = Math.floor(minX);
	const top = Math.floor(minY);
	const width = Math.max(1, Math.ceil(maxX) - left);
	const height = Math.max(1, Math.ceil(maxY) - top);
	const bound = MAX_EM_SPAN * emDots + GLYPH_MARGIN_DOTS;
	if (width > bound || height > bound) {
		return null;
	}
	const bits = new Uint8Array(width * height);

	for (let row = 0; row < height; row++) {
		const y = top + row + 0.5;
		const crossings: number[] = [];
		for (const edge of edges) {
			const { x0, y0, x1, y1 } = edge;
			if (y0 === y1) continue;
			if ((y >= y0 && y < y1) || (y >= y1 && y < y0)) {
				crossings.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
			}
		}
		crossings.sort((a, b) => a - b);
		for (let index = 0; index + 1 < crossings.length; index += 2) {
			const from = Math.max(0, Math.round(crossings[index] - left));
			const to = Math.min(width, Math.round(crossings[index + 1] - left));
			for (let x = from; x < to; x++) bits[row * width + x] = 1;
		}
	}

	return { width, height, left, top, advance, bits };
}

function flatten(commands: PathCommand[]): Edge[] {
	const edges: Edge[] = [];
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	const lineTo = (nx: number, ny: number): void => {
		edges.push({ x0: x, y0: y, x1: nx, y1: ny });
		x = nx;
		y = ny;
	};
	for (const command of commands) {
		switch (command.type) {
			case "M":
				x = startX = command.x;
				y = startY = command.y;
				break;
			case "L":
				lineTo(command.x, command.y);
				break;
			case "Q": {
				const [px, py] = [x, y];
				for (let step = 1; step <= CURVE_STEPS; step++) {
					const t = step / CURVE_STEPS;
					const u = 1 - t;
					lineTo(
						u * u * px + 2 * u * t * command.x1 + t * t * command.x,
						u * u * py + 2 * u * t * command.y1 + t * t * command.y,
					);
				}
				break;
			}
			case "C": {
				const [px, py] = [x, y];
				for (let step = 1; step <= CURVE_STEPS; step++) {
					const t = step / CURVE_STEPS;
					const u = 1 - t;
					lineTo(
						u * u * u * px + 3 * u * u * t * command.x1 + 3 * u * t * t * command.x2 + t * t * t * command.x,
						u * u * u * py + 3 * u * u * t * command.y1 + 3 * u * t * t * command.y2 + t * t * t * command.y,
					);
				}
				break;
			}
			case "Z":
				if (x !== startX || y !== startY) lineTo(startX, startY);
				break;
		}
	}
	return edges;
}
