import opentype from "opentype.js";

/** A parsed font. `id` keys the glyph cache; for a stored font it is the asset id and update time. */
export interface FontFace {
	id: string;
	font: opentype.Font;
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

/** Parses TTF or OTF bytes. Anything opentype.js cannot read, or a font with no glyphs, is refused. */
export function parseFace(id: string, bytes: Buffer): FontFace {
	let font: opentype.Font;
	try {
		font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	} catch (error) {
		throw new InvalidFontError(error instanceof Error ? error.message : "unreadable font");
	}
	if (font.numGlyphs < 2 || font.unitsPerEm < 16) {
		throw new InvalidFontError("the font has no usable glyphs");
	}
	return { id, font };
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

function flatten(commands: opentype.PathCommand[]): Edge[] {
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
