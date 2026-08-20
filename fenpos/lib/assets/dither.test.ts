import { readFileSync } from "node:fs";
import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";
import { decodeImage, ditherToRaster, type ImageRaster } from "@/lib/assets/dither";
import { dotWidth } from "@/lib/markup/blocks";

const PNG = readFileSync("test/fixtures/logo.png");

describe("decodeImage", () => {
	it("reports the pixel dimensions", async () => {
		const decoded = await decodeImage(PNG);
		expect(decoded.width).toBeGreaterThan(0);
		expect(decoded.mimeType).toBe("image/png");
	});

	it("refuses bytes that are not an image", async () => {
		await expect(decodeImage(Buffer.from("not an image"))).rejects.toThrow();
	});

	/**
	 * jimp decodes more formats than this pipeline accepts — GIF, BMP and TIFF all come back as
	 * perfectly good bitmaps. Accepting whatever the decoder happens to understand would let an
	 * animated GIF through as its first frame, so the accepted set is stated here rather than
	 * inherited from the library.
	 */
	it("refuses an image format outside the accepted set", async () => {
		const gif = await new Jimp({ width: 4, height: 4, color: 0xff0000ff }).getBuffer("image/gif");
		await expect(decodeImage(gif)).rejects.toThrow(/gif/i);
	});
});

describe("ditherToRaster", () => {
	it("scales to the requested dot width", async () => {
		expect((await ditherToRaster(PNG, 384)).widthDots).toBe(384);
	});

	it("preserves aspect ratio", async () => {
		const source = await decodeImage(PNG);
		const raster = await ditherToRaster(PNG, 384);
		const expected = Math.round((384 / source.width) * source.height);
		expect(Math.abs(raster.heightDots - expected)).toBeLessThanOrEqual(1);
	});

	it("packs eight pixels to the byte", async () => {
		const raster = await ditherToRaster(PNG, 384);
		expect(raster.packed.length).toBe((raster.widthDots / 8) * raster.heightDots);
	});

	/**
	 * 58mm and 80mm paper — the two widths one install can have behind a single agent, and the
	 * reason a raster is derived per width instead of being dithered once and rescaled.
	 */
	it("rasters the same source at both paper widths", async () => {
		expect((await ditherToRaster(PNG, dotWidth(32))).widthDots).toBe(384);
		expect((await ditherToRaster(PNG, dotWidth(42))).widthDots).toBe(504);
	});

	/**
	 * A dot width is a multiple of twelve, not of eight, so most widths end a row part-way
	 * through a byte. ESC/POS counts raster rows in whole bytes, so the row is padded — and the
	 * padding has to be paper rather than ink, or every row would print a black tail.
	 */
	it("pads a row that does not fill a whole byte", async () => {
		const raster = await ditherToRaster(PNG, dotWidth(3));
		expect(raster.widthDots).toBe(36);
		expect(raster.packed.length).toBe(5 * raster.heightDots);
		for (let row = 0; row < raster.heightDots; row++) {
			expect(raster.packed[row * 5 + 4] & 0x0f, `padding bits of row ${row}`).toBe(0);
		}
	});

	/**
	 * The test that tells error diffusion apart from a plain threshold.
	 *
	 * `logo.png` is a horizontal gradient: every column is one colour top to bottom. Thresholding
	 * each pixel against a fixed value would therefore emit the same bit pattern for every row,
	 * because every row sees the same luminances. Floyd–Steinberg cannot: three sixteenths of each
	 * pixel's error land on the row below, so no two rows decide alike.
	 *
	 * The premise is asserted rather than assumed, so that regenerating the fixture with vertical
	 * variation weakens the test loudly instead of silently.
	 */
	it("diffuses each pixel's error into the row below", async () => {
		expect(await sourceIsColumnConstant(PNG), "fixture must be a purely horizontal gradient").toBe(true);

		const raster = await ditherToRaster(PNG, dotWidth(32));
		const rowBytes = raster.widthDots / 8;
		const patterns = new Set<string>();
		for (let row = 0; row < raster.heightDots; row++) {
			patterns.add(raster.packed.subarray(row * rowBytes, (row + 1) * rowBytes).toString("hex"));
		}
		expect(patterns.size).toBeGreaterThan(1);
	});

	/**
	 * The same distinction seen along a row. At a quarter of the way across the gradient the
	 * source is around a third of full brightness — comfortably dark of any threshold, so a
	 * threshold would fill this run solid black. Diffusion has to spend the accumulated error on
	 * white dots to reproduce the tone.
	 */
	it("renders a mid-tone as mixed dots rather than a solid block", async () => {
		const raster = await ditherToRaster(PNG, dotWidth(32));
		const row = Math.floor(raster.heightDots / 2);
		const run: boolean[] = [];
		for (let x = 96; x < 128; x++) {
			run.push(dotAt(raster, x, row));
		}
		expect(run).toContain(true);
		expect(run).toContain(false);
	});

	/**
	 * A logo with a transparent background is the normal case, and RGB behind a transparent pixel
	 * is usually black. Reading colour without alpha would print those pixels as ink and turn the
	 * whole background into a solid black slab.
	 */
	it("treats transparency as paper rather than ink", async () => {
		const clear = await new Jimp({ width: 16, height: 16, color: 0x00000000 }).getBuffer("image/png");
		const raster = await ditherToRaster(clear, 16);
		expect(raster.packed.every((byte) => byte === 0)).toBe(true);
	});
});

/** Reads one dot out of a packed raster, undoing the MSB-first packing. */
function dotAt(raster: ImageRaster, x: number, y: number): boolean {
	const rowBytes = Math.ceil(raster.widthDots / 8);
	return (raster.packed[y * rowBytes + (x >> 3)] & (0x80 >> (x % 8))) !== 0;
}

/** Whether every column of an image is a single colour, top to bottom. */
async function sourceIsColumnConstant(bytes: Buffer): Promise<boolean> {
	const image = await Jimp.fromBuffer(bytes);
	const { width, height, data } = image.bitmap;
	for (let x = 0; x < width; x++) {
		for (let y = 1; y < height; y++) {
			if (data.readUInt32BE(x * 4) !== data.readUInt32BE((y * width + x) * 4)) {
				return false;
			}
		}
	}
	return true;
}
