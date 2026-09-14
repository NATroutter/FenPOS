import { describe, expect, it } from "vitest";
import { Codepage } from "@/lib/domain/enums";
import { canEncode } from "@/lib/markup/charset";
import { advanceOf, builtinTypeface, bundledFace, typefaceFor } from "@/lib/raster/fonts";
import { hasGlyph } from "@/lib/raster/glyphs";

describe("builtinTypeface", () => {
	it("gives font A a 12-dot advance in a 24-dot cell", () => {
		const a = builtinTypeface("A");

		expect(a.cellHeight).toBe(24);
		expect(advanceOf(a, "0".codePointAt(0) ?? 0)).toBe(12);
		expect(advanceOf(a, "W".codePointAt(0) ?? 0)).toBe(12);
		expect(a.ascent).toBeGreaterThan(12);
		expect(a.ascent).toBeLessThan(24);
	});

	it("gives font B a 9-dot advance in a 17-dot cell", () => {
		const b = builtinTypeface("B");

		expect(b.cellHeight).toBe(17);
		expect(advanceOf(b, "0".codePointAt(0) ?? 0)).toBe(9);
	});
});

describe("typefaceFor", () => {
	it("sizes a cell from the face's ascender and descender", () => {
		const face = typefaceFor(bundledFace(), 40);

		expect(face.emDots).toBe(40);
		expect(face.cellHeight).toBeGreaterThan(40);
		expect(face.ascent).toBeLessThan(face.cellHeight);
	});
});

describe("the bundled font", () => {
	it("covers every character of every supported codepage", () => {
		const missing: string[] = [];
		for (const codepage of Codepage.values) {
			for (let code = 0x20; code < 0x10000; code++) {
				// A codepage byte can round-trip through iconv-lite to a C1 control point (0x7f,
				// 0x80-0x9f) without that being a printable character — no font carries a glyph
				// for a control code, nor should one. Coverage means every encodable *character*.
				if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
				const character = String.fromCharCode(code);
				if (canEncode(character, codepage) && !hasGlyph(bundledFace(), code)) {
					missing.push(`${codepage} U+${code.toString(16)}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});
});
