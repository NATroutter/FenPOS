import { Jimp, JimpMime } from "jimp";
import { describe, expect, it } from "vitest";
import { AVATAR_RENDER_PX, bakeAvatar, requireValidCrop } from "@/lib/auth/avatar-image";
import { ApiError } from "@/lib/errors";
import { pngOf } from "@/test/helpers/images";

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
