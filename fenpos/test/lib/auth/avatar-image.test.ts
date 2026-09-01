import { Jimp, JimpMime } from "jimp";
import { describe, expect, it } from "vitest";
import { AVATAR_BOUNDS, AVATAR_RENDER_PX, bakeAvatar, requireValidCrop } from "@/lib/auth/avatar-image";
import { ApiError } from "@/lib/errors";
import { measureImage } from "@/lib/images/guard";
import { jpegOrientedAt, pngOf } from "@/test/helpers/images";

describe("requireValidCrop", () => {
	it("accepts a square wholly inside the original", () => {
		expect(() => requireValidCrop({ x: 10, y: 10, size: 80 }, { width: 100, height: 100 })).not.toThrow();
	});

	it("refuses one that runs off the right edge", () => {
		expect(() => requireValidCrop({ x: 30, y: 0, size: 80 }, { width: 100, height: 100 })).toThrow(ApiError);
	});

	it("refuses one that runs off the bottom edge", () => {
		expect(() => requireValidCrop({ x: 0, y: 30, size: 80 }, { width: 100, height: 100 })).toThrow(ApiError);
	});

	it("refuses a negative origin", () => {
		expect(() => requireValidCrop({ x: -1, y: 0, size: 10 }, { width: 100, height: 100 })).toThrow(ApiError);
	});

	it("refuses a zero or fractional size", () => {
		expect(() => requireValidCrop({ x: 0, y: 0, size: 0 }, { width: 100, height: 100 })).toThrow(ApiError);
		expect(() => requireValidCrop({ x: 0, y: 0, size: 10.5 }, { width: 100, height: 100 })).toThrow(ApiError);
	});
});

describe("bakeAvatar", () => {
	it("renders a square PNG at the configured size", async () => {
		const baked = await bakeAvatar(await pngOf(200, 120), { x: 20, y: 10, size: 100 });

		expect(baked.mimeType).toBe("image/png");
		expect(baked.size).toBe(AVATAR_RENDER_PX);

		const image = await Jimp.fromBuffer(baked.bytes);
		expect(image.bitmap.width).toBe(AVATAR_RENDER_PX);
		expect(image.bitmap.height).toBe(AVATAR_RENDER_PX);
	});

	it("takes the pixels the crop names, not the whole picture", async () => {
		// Left half red, right half blue. Cropping the right half must come back blue.
		const source = new Jimp({ width: 100, height: 50, color: 0xff0000ff });
		for (let x = 50; x < 100; x++) {
			for (let y = 0; y < 50; y++) {
				source.setPixelColor(0x0000ffff, x, y);
			}
		}
		const baked = await bakeAvatar(await source.getBuffer(JimpMime.png), { x: 50, y: 0, size: 50 });

		const image = await Jimp.fromBuffer(baked.bytes);
		expect(image.getPixelColor(AVATAR_RENDER_PX / 2, AVATAR_RENDER_PX / 2)).toBe(0x0000ffff);
	});

	it("refuses a crop the original cannot satisfy", async () => {
		await expect(bakeAvatar(await pngOf(50, 50), { x: 0, y: 0, size: 80 })).rejects.toBeInstanceOf(ApiError);
	});
});

/**
 * EXIF orientation, which the crop contract silently depends on two parties agreeing about.
 *
 * The cropper takes its dimensions from a browser `<img>`'s `naturalWidth`/`naturalHeight`
 * (`avatar-dialog.tsx`), and browsers apply EXIF orientation by default. The rectangle those numbers
 * produce is then checked server-side by `requireValidCrop` against what `measureImage` reports. So
 * the two must describe the same picture: if the server saw an un-oriented bitmap, an orientation-6
 * portrait phone photo — stored 4000x3000, displayed 3000x4000, the commonest avatar source there is
 * — would have its perfectly ordinary crop refused with "That crop runs past the edge of the image."
 *
 * Measured, not assumed: jimp 1.6.1's Node build **does** honour the tag (`@jimp/core`'s
 * `image-bitmap.js` reads `_exif.tags.Orientation` on load, transforms the pixels, and swaps the
 * dimensions for orientations above 4), so there is no bug to fix here. What there is, is a
 * third-party behaviour the whole crop path leans on with nothing holding it in place. These pin the
 * *agreement* — that this codebase's decode reports what a browser would show — rather than jimp's
 * implementation of it, so a future upgrade that dropped auto-orientation fails here instead of
 * failing in front of an operator uploading a photograph.
 */
describe("EXIF-oriented originals", () => {
	it("measures the dimensions a browser would show, not the ones stored", async () => {
		// Stored 40x20 and tagged "rotate 90° clockwise", so anything honouring the tag sees 20x40.
		const decoded = await measureImage(await jpegOrientedAt(40, 20, 6), AVATAR_BOUNDS);

		expect(decoded.width).toBe(20);
		expect(decoded.height).toBe(40);
	});

	it("accepts the crop those dimensions make legal", async () => {
		// A square at y = 20 is inside a 20x40 picture and off the bottom of a 40x20 one: this is the
		// refusal an operator would meet, expressed as a bake.
		const baked = await bakeAvatar(await jpegOrientedAt(40, 20, 6), { x: 0, y: 20, size: 20 });

		expect(baked.size).toBe(AVATAR_RENDER_PX);
		expect(baked.originalMimeType).toBe("image/jpeg");
	});
});
