import { readFileSync } from "node:fs";
import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";
import { ditherToRaster, type ImageRaster } from "@/lib/assets/dither";
import { rasterToPngDataUrl } from "@/lib/assets/preview";

/**
 * Tests for the Assets tab's preview encoder.
 *
 * These decode what the encoder produced and compare it dot for dot against the raster it was given,
 * because the property that matters cannot be checked by eye in a unit test and is easy to get
 * subtly wrong: bit order. Packing MSB-first and reading LSB-first mirrors every eight-dot block,
 * which on a dithered photograph looks like noise — that is to say, like a dither — and would ship.
 */

const PNG = readFileSync("test/fixtures/logo.png");

/** A raster 12 dots wide, so each row is two bytes with four bits of padding the image excludes. */
const NARROW: ImageRaster = {
	widthDots: 12,
	heightDots: 3,
	packed: Buffer.from([
		// The leftmost dot, then padding bits set past the right edge to prove they are not drawn.
		0b1000_0000, 0b0000_1111,
		// The rightmost real dot, x = 11.
		0b0000_0000, 0b0001_0000,
		// Every dot in the row.
		0b1111_1111, 0b1111_0000,
	]),
};

/**
 * Decodes a data URI back into a bitmap.
 *
 * @param dataUrl what the encoder returned
 * @returns the decoded image
 */
async function decode(dataUrl: string): Promise<Awaited<ReturnType<typeof Jimp.fromBuffer>>> {
	const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
	return Jimp.fromBuffer(Buffer.from(base64, "base64"));
}

/**
 * Whether a decoded pixel is ink.
 *
 * @param image the decoded image
 * @param x dot across
 * @param y dot down
 * @returns true when the pixel is black
 */
function isInk(image: Awaited<ReturnType<typeof Jimp.fromBuffer>>, x: number, y: number): boolean {
	return image.bitmap.data[(y * image.bitmap.width + x) * 4] < 128;
}

describe("rasterToPngDataUrl", () => {
	it("produces a PNG data URI", async () => {
		expect(await rasterToPngDataUrl(NARROW)).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
	});

	it("keeps the raster's own dimensions, padding bits excluded", async () => {
		const image = await decode(await rasterToPngDataUrl(NARROW));

		expect(image.bitmap.width).toBe(12);
		expect(image.bitmap.height).toBe(3);
	});

	it("inks exactly the dots whose bits are set, most significant bit leftmost", async () => {
		const image = await decode(await rasterToPngDataUrl(NARROW));

		const inked: string[] = [];
		for (let y = 0; y < 3; y++) {
			for (let x = 0; x < 12; x++) {
				if (isInk(image, x, y)) {
					inked.push(`${x},${y}`);
				}
			}
		}

		expect(inked).toEqual(["0,0", "11,1", ...Array.from({ length: 12 }, (_, x) => `${x},2`)]);
	});

	it("round-trips a real dithered image dot for dot", async () => {
		const raster = await ditherToRaster(PNG, 384);
		const image = await decode(await rasterToPngDataUrl(raster));

		expect(image.bitmap.width).toBe(raster.widthDots);
		expect(image.bitmap.height).toBe(raster.heightDots);

		const rowBytes = Math.ceil(raster.widthDots / 8);
		let wrong = 0;
		for (let y = 0; y < raster.heightDots; y++) {
			for (let x = 0; x < raster.widthDots; x++) {
				const bit = (raster.packed[y * rowBytes + (x >> 3)] & (0x80 >> (x % 8))) !== 0;
				if (bit !== isInk(image, x, y)) {
					wrong++;
				}
			}
		}

		expect(wrong).toBe(0);
	});

	it("draws a dithered photograph as two tones, not as greys", async () => {
		// The point of dithering server-side is that the panel shows the printer's own answer. If
		// the encoder ever smoothed or resampled, this is what would notice: an ESC/POS raster has
		// exactly two values, and anything between them is a tone no thermal head can produce.
		const image = await decode(await rasterToPngDataUrl(await ditherToRaster(PNG, 384)));

		const tones = new Set<number>();
		for (let at = 0; at < image.bitmap.data.length; at += 4) {
			tones.add(image.bitmap.data[at]);
		}

		expect([...tones].sort((a, b) => a - b)).toEqual([0, 255]);
	});
});
