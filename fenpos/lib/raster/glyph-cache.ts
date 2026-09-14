import { type FontFace, type GlyphBitmap, rasterizeGlyph } from "@/lib/raster/glyphs";

/**
 * A process-wide cache of rendered glyphs, bounded by bytes rather than by entry count.
 *
 * A raster line rasterizes the same handful of glyphs over and over — one per repeated
 * character, and again for every job that reuses a device's font. Rendering is a scanline fill
 * over a flattened outline, cheap once but not free at the volume a busy printer sees, so this
 * remembers what has already been drawn.
 */

/** The cache's byte bound. Entries are evicted oldest-first once this is exceeded. */
export const GLYPH_CACHE_BYTES = 8 * 1024 * 1024;

/** The per-entry overhead added to `bits.length`, standing in for the bitmap's other fields. */
const ENTRY_OVERHEAD = 64;

/**
 * The cache itself, doubling as an LRU order: `Map` iterates in insertion order, so the entry at
 * `keys().next()` is always the least recently touched. A hit deletes and re-inserts its key to
 * move it to the back; a miss that fills the cache evicts from the front until there is room.
 *
 * A `null` value means "this face has no glyph for this code point at this size" — recording
 * that costs one entry but saves re-rasterizing (and re-failing to find) the same missing glyph
 * on every later reference to it.
 */
const cache = new Map<string, GlyphBitmap | null>();

/** Total bytes currently held, kept alongside the map rather than recomputed on every read. */
let bytes = 0;

function costOf(glyph: GlyphBitmap | null): number {
	return (glyph?.bits.length ?? 0) + ENTRY_OVERHEAD;
}

function keyFor(face: FontFace, codepoint: number, emDots: number): string {
	return `${face.id}:${emDots}:${codepoint}`;
}

/**
 * Renders one glyph through the cache, keyed by face, size and code point.
 *
 * @param face the parsed font
 * @param codepoint the character to render
 * @param emDots the em size in dots
 * @returns the same {@link GlyphBitmap} instance on every call with the same key, or null when
 *          the face has no glyph for the code point
 */
export function cachedGlyph(face: FontFace, codepoint: number, emDots: number): GlyphBitmap | null {
	const key = keyFor(face, codepoint, emDots);
	if (cache.has(key)) {
		const glyph = cache.get(key) ?? null;
		// Move to the back: this key was just used, so it is the least eligible for eviction.
		cache.delete(key);
		cache.set(key, glyph);
		return glyph;
	}

	const glyph = rasterizeGlyph(face, codepoint, emDots);
	cache.set(key, glyph);
	bytes += costOf(glyph);

	while (bytes > GLYPH_CACHE_BYTES && cache.size > 0) {
		const oldestKey = cache.keys().next().value as string;
		const evicted = cache.get(oldestKey) ?? null;
		cache.delete(oldestKey);
		bytes -= costOf(evicted);
	}

	return glyph;
}

/** The cache's current size, for tests and diagnostics. */
export function glyphCacheStats(): { entries: number; bytes: number } {
	return { entries: cache.size, bytes };
}

/** Empties the cache. For tests: each test starts with a clean process-wide cache. */
export function forgetGlyphs(): void {
	cache.clear();
	bytes = 0;
}
