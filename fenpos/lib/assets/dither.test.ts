import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";
import {
	decodeImage,
	ditherToRaster,
	ImageDecodeError,
	type ImageRaster,
	projectedHeightDots,
} from "@/lib/assets/dither";
import { IMAGE_LIMITS } from "@/lib/link/protocol";
import { dotWidth } from "@/lib/markup/blocks";

const PNG = readFileSync("test/fixtures/logo.png");

/** A plain white PNG of a given shape, for the tests that care about proportions rather than pixels. */
async function solidPng(width: number, height: number): Promise<Buffer> {
	return await new Jimp({ width, height, color: 0xffffffff }).getBuffer("image/png");
}

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

	/**
	 * The decoder gets its own bounds, because a caller's dimension check cannot help here.
	 *
	 * `jpeg-js` allocates one `Int32Array(64)` per coefficient block *while parsing the frame
	 * header*, so a file with no scan data at all — the 21-byte fixture below — allocates for the
	 * whole image. Left at the library's defaults it will do that for anything up to 100 megapixels,
	 * which is six times what this pipeline accepts, and it bills each block at 256 bytes while V8
	 * charges roughly 2.5x that in reality.
	 *
	 * The assertion is on memory rather than on the throw, deliberately: the decoder rejects this
	 * file either way, and the only thing that changes when the bound is removed is *how much it
	 * allocated first*. 25 megapixels across three components costs about 300 MB unbounded, so the
	 * 64 MB threshold is a wide margin around "did not allocate for the frame at all".
	 *
	 * Measured before and after rather than sampled, because the parse is synchronous: a timer
	 * callback cannot fire in the middle of it.
	 */
	it("refuses an oversized JPEG frame without allocating for it first", async () => {
		const frame = jpegFrameHeader(5000, 5000, 3);

		const before = process.memoryUsage().rss;
		await expect(decodeImage(frame)).rejects.toThrow();
		const after = process.memoryUsage().rss;

		expect(after - before).toBeLessThan(64 * 1024 * 1024);
	});
});

/**
 * Builds a JPEG that is nothing but a frame header declaring a size and a component count.
 *
 * A real JPEG carries its size behind however many EXIF and comment segments the camera wrote, and
 * then a scan. None of that is needed to make the decoder allocate, which is the point of building
 * this by hand: the allocation happens on the header, so the header is the whole exploit.
 *
 * @param width the frame width to declare
 * @param height the frame height to declare
 * @param components how many components to declare, each of which is allocated for separately
 * @returns SOI followed by an SOF0 segment and nothing else
 */
function jpegFrameHeader(width: number, height: number, components: number): Buffer {
	const length = 8 + components * 3;
	const jpeg = Buffer.alloc(4 + length);
	jpeg.writeUInt16BE(0xffd8, 0); // SOI
	jpeg.writeUInt16BE(0xffc0, 2); // SOF0
	jpeg.writeUInt16BE(length, 4);
	jpeg[6] = 8; // sample precision
	jpeg.writeUInt16BE(height, 7);
	jpeg.writeUInt16BE(width, 9);
	jpeg[11] = components;
	for (let component = 0; component < components; component++) {
		jpeg[12 + component * 3] = component + 1;
		jpeg[13 + component * 3] = 0x11; // sampling factors h=1, v=1
	}
	return jpeg;
}

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

	/**
	 * The projection is only worth anything if it is the size jimp would really have produced.
	 *
	 * The shapes below are chosen so that `Math.floor` and `Math.ceil` give different answers from
	 * `Math.round` — 3/7 of 384 is 164.57, 5/13 of 504 is 193.8 — so a projection that rounded the
	 * other way would disagree here rather than pass by coincidence on a shape whose arithmetic
	 * happens to be exact.
	 */
	it("projects the height the resize actually produces", async () => {
		for (const [width, height, target] of [
			[7, 3, 384],
			[13, 5, 504],
			[11, 7, 576],
			[9, 2, 384],
		] as const) {
			const raster = await ditherToRaster(await solidPng(width, height), target);
			expect(raster.heightDots, `${width}x${height} at ${target}`).toBe(projectedHeightDots(width, height, target));
		}
	});

	/**
	 * The bound no other image limit gives.
	 *
	 * A 4x1024 PNG is about 1,100 bytes and is inside every guard on the upload path — the 2 MB byte
	 * cap, 4096 pixels a side, not interlaced, well under the JPEG decode budget — because none of
	 * them looks at the *shape*. Resized to 384 dots preserving aspect it becomes 384x98,304, which
	 * measured through this function cost +439 MB resident before this check existed.
	 *
	 * The assertion is on memory as well as on the throw, and that is the load-bearing half: the
	 * protocol's `maxHeightDots` was already checked, but only once the dots existed. What changed
	 * is that the refusal now happens before the resize allocates, so a version that moved the check
	 * back after `image.resize` would still throw and would still fail this test.
	 */
	it("refuses an extreme-aspect source before the resize allocates", async () => {
		const tall = await solidPng(4, 1024);

		const before = process.memoryUsage().rss;
		await expect(ditherToRaster(tall, 384)).rejects.toThrow(ImageDecodeError);
		const after = process.memoryUsage().rss;

		expect(after - before).toBeLessThan(64 * 1024 * 1024);
	});

	/** The message has to name the size and the ceiling, or the operator cannot act on it. */
	it("names the projected height in the refusal", async () => {
		await expect(ditherToRaster(await solidPng(4, 1024), 384)).rejects.toThrow(/98304 dots tall/);
	});

	/**
	 * The boundary, from both sides.
	 *
	 * Exercised at five dots wide rather than at a real paper width because a raster right on
	 * `maxHeightDots` is genuinely enormous — at 3060 dots the intermediate luminance buffer alone
	 * is 1.5 GB — and the arithmetic being pinned is the comparison, not the width. Five divides
	 * 65,535 exactly, which is what makes this a real boundary: 13,107 source rows project to
	 * precisely the ceiling and 13,108 to five dots past it, so a check written `>=` instead of `>`
	 * refuses the first of these and fails here. A cheaper width like eight would leave a gap at the
	 * top and let that mutation through.
	 */
	it("accepts the tallest raster that fits and refuses the next one", async () => {
		const fits = Math.floor(IMAGE_LIMITS.maxHeightDots / 5);
		expect(projectedHeightDots(1, fits, 5), "the boundary must be exact").toBe(IMAGE_LIMITS.maxHeightDots);
		expect(projectedHeightDots(1, fits + 1, 5)).toBeGreaterThan(IMAGE_LIMITS.maxHeightDots);

		const raster = await ditherToRaster(await solidPng(1, fits), 5);
		expect(raster.heightDots).toBe(IMAGE_LIMITS.maxHeightDots);
		await expect(ditherToRaster(await solidPng(1, fits + 1), 5)).rejects.toThrow(ImageDecodeError);
	});

	/**
	 * A phone photograph is the case the cap must not catch. 4032x3024 off a 12 MP sensor is 432
	 * rows at 80mm paper — see `MAX_IMAGE_DIMENSION`, which stays at 4096 for exactly this reason.
	 */
	it("still rasters a full-size phone photograph", async () => {
		const raster = await ditherToRaster(await solidPng(4032, 3024), 576);
		expect(raster.heightDots).toBe(432);
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
	 * The whole raster, pinned.
	 *
	 * The two tests above separate error diffusion from a plain threshold, but they do not separate
	 * the right kernel from a wrong one. Transposing the 3/16 and 5/16 weights, scrambling all four,
	 * or sending the entire error straight down all still produce a raster whose rows differ and
	 * whose mid-tones are mixed — so both still pass while every printed image is subtly wrong. A
	 * property test cannot catch that; only the bytes can.
	 *
	 * **If this hash fails, the printed output changed.** It is not a number to refresh until the
	 * test goes green. Something moved — the kernel, the resize, the greyscale weights, the
	 * threshold, the packing, or jimp's resampling under a version bump — and the question to answer
	 * first is whether the new picture is the one that should come off the printer. Only then record
	 * the new hash, and say in the commit message what changed about the printed image.
	 */
	it("renders the recorded raster, dot for dot", async () => {
		const raster = await ditherToRaster(PNG, 384);
		expect(createHash("sha256").update(raster.packed).digest("hex")).toBe(
			"6d4655639de591f303d529377008a26ca1852064b1d1402e6ba21423243df49b",
		);
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
