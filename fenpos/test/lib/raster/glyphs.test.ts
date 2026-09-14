import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type GlyphBitmap, hasGlyph, InvalidFontError, parseFace, rasterizeGlyph } from "@/lib/raster/glyphs";

const FACE = parseFace("dejavu", readFileSync(path.join(process.cwd(), "public/fonts/DejaVuSansMono.ttf")));

const art = (glyph: GlyphBitmap): string => {
	const rows: string[] = [];
	for (let y = 0; y < glyph.height; y++) {
		let row = "";
		for (let x = 0; x < glyph.width; x++) row += glyph.bits[y * glyph.width + x] ? "#" : ".";
		rows.push(row);
	}
	return rows.join("\n");
};

describe("parseFace", () => {
	it("refuses bytes that are not a font", () => {
		expect(() => parseFace("x", Buffer.from("not a font"))).toThrow(InvalidFontError);
	});
});

describe("rasterizeGlyph", () => {
	it("renders a capital I as a solid vertical bar with serifs at 24 dots", () => {
		const glyph = rasterizeGlyph(FACE, "I".codePointAt(0) ?? 0, 24);

		expect(glyph).not.toBeNull();
		expect(glyph?.advance).toBe(14);
		expect(glyph?.top).toBeLessThan(0);
		expect(art(glyph as GlyphBitmap)).toMatchSnapshot();
	});

	it("gives a space no bitmap but an advance", () => {
		const glyph = rasterizeGlyph(FACE, 0x20, 24);

		expect(glyph?.width).toBe(0);
		expect(glyph?.advance).toBe(14);
	});

	it("scales with the em size", () => {
		const small = rasterizeGlyph(FACE, 0x41, 12);
		const large = rasterizeGlyph(FACE, 0x41, 24);

		expect(large?.height).toBeGreaterThan((small?.height ?? 0) * 1.5);
		expect(large?.advance).toBe((small?.advance ?? 0) * 2);
	});

	it("fills a counter with even-odd so an O is hollow", () => {
		const glyph = rasterizeGlyph(FACE, "O".codePointAt(0) ?? 0, 32) as GlyphBitmap;
		const middle = glyph.bits[Math.floor(glyph.height / 2) * glyph.width + Math.floor(glyph.width / 2)];

		expect(middle).toBe(0);
	});

	it("returns null for a code point the face lacks", () => {
		expect(hasGlyph(FACE, 0x1f600)).toBe(false);
		expect(rasterizeGlyph(FACE, 0x1f600, 24)).toBeNull();
	});

	it("has a glyph for every character the codepages can encode", () => {
		// The bundled font is the fallback for every native character inside a raster, so a gap
		// here would print a `?` for a character the printer itself could draw.
		expect(hasGlyph(FACE, "€".codePointAt(0) ?? 0)).toBe(true);
		expect(hasGlyph(FACE, "─".codePointAt(0) ?? 0)).toBe(true);
		expect(hasGlyph(FACE, "ä".codePointAt(0) ?? 0)).toBe(true);
	});
});
