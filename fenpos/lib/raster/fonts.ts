import { readFileSync } from "node:fs";
import path from "node:path";
import { cachedGlyph } from "@/lib/raster/glyph-cache";
import type { FontFace } from "@/lib/raster/glyphs";
import { parseFace } from "@/lib/raster/glyphs";

/**
 * The bundled face, and the printer's own two built-in fonts rendered from it.
 *
 * **Why A and B are metric-matched to the printer's fonts.** A device's native text — the labels
 * a raster is placed beside, or drawn onto a line that itself came from `fill` and `align` — sets
 * its columns from the printer's own font metrics: 12 dots per character in a 24-dot line for
 * font A, 9 in 17 for font B. A raster glyph drawn with any other advance would drift out of step
 * with that native text a column at a time. Matching the advance exactly is what lets `fill` and
 * `align` inside a drawn line land on the same dot column native text would land on, on the same
 * paper.
 */

/** The id `cachedGlyph` keys entries under for the bundled face. */
export const BUNDLED_FONT_ID = "dejavu-sans-mono";

/** A font rendered at one size, with the cell geometry a line is laid out against. */
export interface Typeface {
	face: FontFace;
	emDots: number;
	/** The full line height in dots, including any descender room. */
	cellHeight: number;
	/** The baseline's offset from the top of the cell, in dots. */
	ascent: number;
}

const SOURCE = path.join(process.cwd(), "public", "fonts", "DejaVuSansMono.ttf");

let face: FontFace | undefined;

/** The bundled DejaVu Sans Mono face, read from disk once and memoised. */
export function bundledFace(): FontFace {
	face ??= parseFace(BUNDLED_FONT_ID, readFileSync(SOURCE));
	return face;
}

/** Font A's fixed advance and cell height, in dots. */
const FONT_A = { advance: 12, cellHeight: 24 } as const;
/** Font B's fixed advance and cell height, in dots. */
const FONT_B = { advance: 9, cellHeight: 17 } as const;

const builtinTypefaces = new Map<"A" | "B", Typeface>();

/**
 * One of the printer's two built-in fonts, rendered from the bundled face at whatever em size
 * makes its advance land on the printer's own column width.
 *
 * @param font "A" for the 12-dot, 24-cell font; "B" for the 9-dot, 17-cell font
 */
export function builtinTypeface(font: "A" | "B"): Typeface {
	const cached = builtinTypefaces.get(font);
	if (cached) {
		return cached;
	}

	const { advance, cellHeight } = font === "A" ? FONT_A : FONT_B;
	const bundled = bundledFace();
	const zeroWidth = bundled.font.charToGlyph("0").advanceWidth ?? bundled.font.unitsPerEm;
	const unitsPerEm = bundled.font.unitsPerEm;

	// Not rounded: opentype scales a glyph's outline by a floating-point em size, so this is the
	// exact size at which "0"'s rendered advance rounds to the printer's own column width.
	const emDots = (advance * unitsPerEm) / zeroWidth;
	const ascent = Math.min(cellHeight - 1, Math.round((bundled.font.ascender / unitsPerEm) * emDots));

	const typeface: Typeface = { face: bundled, emDots, cellHeight, ascent };
	builtinTypefaces.set(font, typeface);
	return typeface;
}

/**
 * Sizes a face's cell from its own ascender and descender, for text drawn at an arbitrary point
 * size rather than at one of the printer's built-in font widths.
 *
 * @param face the parsed font
 * @param sizeDots the em size in dots
 */
export function typefaceFor(face: FontFace, sizeDots: number): Typeface {
	const unitsPerEm = face.font.unitsPerEm;
	const cellHeight = Math.ceil(((face.font.ascender - face.font.descender) / unitsPerEm) * sizeDots);
	const ascent = Math.round((face.font.ascender / unitsPerEm) * sizeDots);
	return { face, emDots: sizeDots, cellHeight, ascent };
}

/**
 * The advance of one character at a typeface's size, through the glyph cache.
 *
 * @returns the advance in dots, or 0 when the face has no glyph for the code point
 */
export function advanceOf(typeface: Typeface, codepoint: number): number {
	return cachedGlyph(typeface.face, codepoint, typeface.emDots)?.advance ?? 0;
}
