import { beforeEach, describe, expect, it } from "vitest";
import { bundledFace } from "@/lib/raster/fonts";
import { cachedGlyph, forgetGlyphs, GLYPH_CACHE_BYTES, glyphCacheStats } from "@/lib/raster/glyph-cache";

describe("the glyph cache", () => {
	beforeEach(() => forgetGlyphs());

	it("renders once and serves the same bitmap after", () => {
		const first = cachedGlyph(bundledFace(), 0x41, 24);
		const second = cachedGlyph(bundledFace(), 0x41, 24);

		expect(second).toBe(first);
		expect(glyphCacheStats().entries).toBe(1);
	});

	it("keys by size", () => {
		cachedGlyph(bundledFace(), 0x41, 24);
		cachedGlyph(bundledFace(), 0x41, 25);

		expect(glyphCacheStats().entries).toBe(2);
	});

	it("stays under its byte bound by evicting the least recently used", () => {
		let codepoint = 0x21;
		while (glyphCacheStats().bytes < GLYPH_CACHE_BYTES * 0.9 && codepoint < 0x2fff) {
			cachedGlyph(bundledFace(), codepoint, 200);
			codepoint += 1;
		}
		const before = glyphCacheStats();
		cachedGlyph(bundledFace(), 0x41, 400);
		cachedGlyph(bundledFace(), 0x42, 400);

		expect(glyphCacheStats().bytes).toBeLessThanOrEqual(GLYPH_CACHE_BYTES);
		expect(glyphCacheStats().entries).toBeLessThanOrEqual(before.entries + 2);
		expect(cachedGlyph(bundledFace(), 0x21, 200)).not.toBeNull();
	});
});
