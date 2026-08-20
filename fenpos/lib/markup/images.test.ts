import { readFileSync } from "node:fs";
import { Jimp, JimpMime } from "jimp";
import { describe, expect, it } from "vitest";
import { ditherToRaster } from "@/lib/assets/dither";
import { imageGeometry } from "@/lib/markup/images";

/**
 * Tests for how much paper an image costs.
 *
 * One property carries this module, and it is the last test in each pair: the size charged against
 * the line budget has to be the size of the raster the printer is actually sent. Those are computed
 * by two different pieces of code — this one from the stored dimensions, `ditherToRaster` from the
 * pixels — and they are allowed to be, because the budget has to be known before an image is
 * dithered and often without dithering it at all. What they are not allowed to do is disagree, so
 * the arithmetic here is pinned against jimp's own resize rather than against itself.
 */

/** A real 128x40 PNG, the same fixture the dither and asset tests use. */
const PNG = readFileSync("test/fixtures/logo.png");

/** The fixture's dimensions, stated rather than read, so a swapped fixture fails loudly. */
const LOGO = { width: 128, height: 40 };

/** Ten columns of a 12-dot font, matching the device fixture in `compiler.test.ts`. */
const NARROW_COLUMNS = 10;

/** Thirty-two columns, which is 384 dots: the common 58mm printer. */
const PAPER_COLUMNS = 32;

describe("imageGeometry", () => {
	it("prints a full-width image across the whole paper", () => {
		expect(imageGeometry(LOGO, 100, PAPER_COLUMNS)).toEqual({
			widthDots: 384,
			heightDots: 120,
			heightLines: 5,
		});
	});

	it("costs a half-width image half the dots on each side", () => {
		expect(imageGeometry(LOGO, 50, PAPER_COLUMNS)).toEqual({
			widthDots: 192,
			heightDots: 60,
			heightLines: 3,
		});
	});

	it("charges whole lines, because paper only advances by whole lines", () => {
		// 60 dots is two and a half lines of 24, and half a line of paper cannot be fed back.
		expect(imageGeometry(LOGO, 50, PAPER_COLUMNS).heightLines).toBe(3);
	});

	it("scales with the paper, so the same markup fits both widths", () => {
		expect(imageGeometry(LOGO, 100, NARROW_COLUMNS)).toEqual({
			widthDots: 120,
			heightDots: 38,
			heightLines: 2,
		});
	});

	/**
	 * The one that matters. `ditherToRaster` resizes with jimp, which rounds the height its own
	 * way; anything computed here that rounds differently would charge a line the printer does not
	 * use, or fail to charge one it does.
	 */
	it("measures what the dither will actually produce", async () => {
		for (const percent of [100, 50, 33, 7]) {
			const geometry = imageGeometry(LOGO, percent, PAPER_COLUMNS);
			const raster = await ditherToRaster(PNG, geometry.widthDots);

			expect({ widthDots: raster.widthDots, heightDots: raster.heightDots }).toEqual({
				widthDots: geometry.widthDots,
				heightDots: geometry.heightDots,
			});
		}
	});

	/**
	 * A banner scaled down far enough that the arithmetic wants a fraction of a dot. jimp keeps a
	 * row, so this has to as well: charging zero lines for something that prints would let a job
	 * past the budget it was measured against.
	 */
	it("keeps a dot row for an image too short to round up to one", async () => {
		const banner = await new Jimp({ width: 2000, height: 3, color: 0x000000ff }).getBuffer(JimpMime.png);
		const geometry = imageGeometry({ width: 2000, height: 3 }, 100, PAPER_COLUMNS);
		const raster = await ditherToRaster(banner, geometry.widthDots);

		expect(geometry.heightDots).toBe(raster.heightDots);
		expect(geometry.heightLines).toBe(1);
	});

	/**
	 * The case the clamp actually exists for, and the one the test above does *not* cover: three
	 * dots of height over 2000 rounds to one on its own, so that test passes with the clamp deleted.
	 * This one does not. A 4096-pixel source at one percent of 32 columns is four dots wide, which
	 * puts its height at `round(1 x 4 / 4096)` = 0 — an image charged nothing at all against
	 * `maxOutputLines`, which is precisely the undercount the whole measurement exists to prevent.
	 */
	it("charges a line for an image the arithmetic would round out of existence", () => {
		expect(imageGeometry({ width: 4096, height: 1 }, 1, PAPER_COLUMNS)).toEqual({
			widthDots: 4,
			heightDots: 1,
			heightLines: 1,
		});
	});

	it("refuses a source with no pixels, rather than charging a NaN of paper", () => {
		expect(() => imageGeometry({ width: 0, height: 0 }, 100, PAPER_COLUMNS)).toThrow(RangeError);
	});
});
