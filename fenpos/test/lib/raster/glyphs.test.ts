import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Font } from "opentype.js";
import { describe, expect, it, vi } from "vitest";
import {
	type FontFace,
	type GlyphBitmap,
	hasGlyph,
	InvalidFontError,
	parseFace,
	rasterizeGlyph,
} from "@/lib/raster/glyphs";

/**
 * Stands in for the parser, so a face with impossible metrics can reach `parseFace` without a file
 * that carries them.
 *
 * Replaces the named export rather than a property of an imported object, because the module has no
 * object to reach into: see "the opentype import" below for what the package actually exports.
 * Falls through to the real parser unless a test says otherwise, so the face read from disk here is
 * still a real one.
 */
const parseFont = vi.hoisted(() => vi.fn());

vi.mock("opentype.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("opentype.js")>();
	parseFont.mockImplementation(actual.parse);
	return { ...actual, parse: parseFont };
});

const OPENTYPE_DIRECTORY = path.join(process.cwd(), "node_modules/opentype.js");

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

	/**
	 * A font whose metrics are a lie about its size.
	 *
	 * Sixteen units to the em with coordinates near the end of the signed short range describes a
	 * glyph two thousand ems tall. Nothing downstream would question it: the bitmap is sized from the
	 * outline and the cell height from the ascender, so the numbers a stranger uploaded decide how
	 * much memory the process is about to ask for.
	 */
	it("refuses a face whose declared outlines run far outside its em", () => {
		const absurd = {
			numGlyphs: 200,
			unitsPerEm: 16,
			ascender: 32767,
			descender: -32768,
			tables: { head: { xMin: -32768, xMax: 32767, yMin: -32768, yMax: 32767 } },
		} as unknown as Font;
		parseFont.mockReturnValueOnce(absurd);

		expect(() => parseFace("x", Buffer.from("anything"))).toThrow(InvalidFontError);
	});

	it("refuses a face whose head box alone is outsized, with a plausible line height", () => {
		const absurd = {
			numGlyphs: 200,
			unitsPerEm: 1000,
			ascender: 800,
			descender: -200,
			tables: { head: { xMin: -20000, xMax: 20000, yMin: -200, yMax: 800 } },
		} as unknown as Font;
		parseFont.mockReturnValueOnce(absurd);

		expect(() => parseFace("x", Buffer.from("anything"))).toThrow(InvalidFontError);
	});

	it("keeps accepting a real face", () => {
		expect(FACE.font.numGlyphs).toBeGreaterThan(2);
	});
});

/**
 * How this module takes its parser.
 *
 * `opentype.js` ships two builds and points `module` at the ECMAScript one, which exports its
 * functions by name and nothing by default. Node resolves `main` instead — CommonJS, whose exports
 * object arrives as a synthesised default — so a default import runs perfectly under vitest and
 * under `tsx` and fails only once the panel is bundled. It fails there at the whole module graph:
 * the parser is reached from the agent link, which is reached from startup, so every route in the
 * panel answers 500 rather than only the ones that draw glyphs.
 */
describe("the opentype import", () => {
	it("names what it takes, because the build a bundler resolves exports no default", async () => {
		const manifest = JSON.parse(readFileSync(path.join(OPENTYPE_DIRECTORY, "package.json"), "utf8")) as {
			module: string;
		};
		const bundled = (await import(pathToFileURL(path.join(OPENTYPE_DIRECTORY, manifest.module)).href)) as Record<
			string,
			unknown
		>;

		expect(bundled.default).toBeUndefined();
		expect(typeof bundled.parse).toBe("function");

		const source = readFileSync(path.join(process.cwd(), "lib/raster/glyphs.ts"), "utf8");
		expect(source).not.toMatch(/import\s+[A-Za-z_$][\w$]*\s+from\s+"opentype\.js"/);
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

	/**
	 * The last line of defence, past the metrics {@link parseFace} reads.
	 *
	 * A glyph whose scaled outline is hundreds of times the em it was asked for would otherwise size
	 * a bitmap of tens of thousands of dots a side. Treating it as missing costs one character; the
	 * allocation costs the request.
	 */
	it("treats a glyph far larger than the em it was drawn at as missing", () => {
		const face = {
			id: "absurd",
			font: {
				unitsPerEm: 2048,
				charToGlyphIndex: () => 1,
				charToGlyph: () => ({
					advanceWidth: 2048,
					getPath: () => ({
						commands: [
							{ type: "M", x: 0, y: 0 },
							{ type: "L", x: 60000, y: 0 },
							{ type: "L", x: 60000, y: 60000 },
							{ type: "Z" },
						],
					}),
				}),
			},
		} as unknown as FontFace;

		expect(rasterizeGlyph(face, 0x41, 24)).toBeNull();
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
