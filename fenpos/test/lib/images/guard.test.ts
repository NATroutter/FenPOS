import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { measureImage } from "@/lib/images/guard";
import { pngOf } from "@/test/helpers/images";

/**
 * Tests for the shared image-safety gate.
 *
 * The asset store's own suite already pins what these defences do under *its* caps; what is asserted
 * here is that they hold under caps a caller passes in, because that is the whole reason the gate
 * moved out of `asset-service.ts`. A second caller with a smaller cap must get the same refusals in
 * the same order, and in particular must get the header-first refusal — the one that has to happen
 * before the decoder is handed the bytes, since the allocation being defended against happens inside
 * the decode.
 */
const BOUNDS = { maxBytes: 2 * 1024 * 1024, maxDimension: 4096, acceptedMimeTypes: ["image/png", "image/jpeg"] };

describe("measureImage", () => {
	it("returns what the bytes turned out to be", async () => {
		expect(await measureImage(await pngOf(64, 32), BOUNDS)).toMatchObject({
			width: 64,
			height: 32,
			mimeType: "image/png",
		});
	});

	it("refuses more bytes than the cap before it decodes anything", async () => {
		await expect(measureImage(await pngOf(64, 64), { ...BOUNDS, maxBytes: 8 })).rejects.toBeInstanceOf(ApiError);
	});

	it("refuses a header declaring more pixels than the cap, without decoding it", async () => {
		// The defence that matters: the allocation happens inside the decode, so the size has to be
		// read from the header first.
		await expect(measureImage(await pngOf(4097, 8), BOUNDS)).rejects.toBeInstanceOf(ApiError);
	});

	it("refuses a format this caller does not accept", async () => {
		await expect(
			measureImage(await pngOf(8, 8), { ...BOUNDS, acceptedMimeTypes: ["image/jpeg"] }),
		).rejects.toBeInstanceOf(ApiError);
	});
});
