import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { measureImage } from "@/lib/images/guard";
import { pngHeaderClaiming, pngOf } from "@/test/helpers/images";

/**
 * Tests for the shared image-safety gate.
 *
 * The asset store's own suite already pins what these defences do under *its* caps; what is asserted
 * here is that they hold under caps a caller passes in, because that is the whole reason the gate
 * moved out of `asset-service.ts`. A second caller with a smaller cap must get the same refusals in
 * the same order.
 *
 * **The order is what these tests are for, and only header-only bytes can see it.** Every check in
 * this module exists because the allocation being defended against happens *inside* the decode, so
 * a check that runs afterwards runs after the damage. A real, decodable image cannot tell the two
 * arrangements apart — it is refused either way, just as loudly, and a suite built on one would stay
 * green while the guard was quietly reordered into uselessness. {@link pngHeaderClaiming} is a
 * header with no image behind it: it decodes for nobody, so being told the *dimensions* are wrong
 * is only possible if the size was read before the decoder was handed the bytes. Which refusal
 * arrives is therefore the assertion, and `.code` is where it is read.
 */
const BOUNDS = { maxBytes: 2 * 1024 * 1024, maxDimension: 4096, acceptedMimeTypes: ["image/png", "image/jpeg"] };

/**
 * Runs something expected to fail and returns the `ApiError` it raised.
 *
 * @param work the call under test
 * @returns the error, having asserted it is an ApiError
 */
async function refusal(work: () => Promise<unknown>): Promise<ApiError> {
	try {
		await work();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(ApiError);
		return thrown as ApiError;
	}
	throw new Error("expected a refusal, got a success");
}

describe("measureImage", () => {
	it("returns what the bytes turned out to be", async () => {
		expect(await measureImage(await pngOf(64, 32), BOUNDS)).toMatchObject({
			width: 64,
			height: 32,
			mimeType: "image/png",
		});
	});

	/**
	 * Header-only bytes, so the byte cap is the only check that can produce this code: a decode of
	 * these would fail as `invalid_image`, and a byte check moved behind the decode would never be
	 * reached. `body_too_large` therefore means the bytes were counted first.
	 */
	it("refuses more bytes than the cap before it decodes anything", async () => {
		const refused = await refusal(() => measureImage(pngHeaderClaiming(64, 64), { ...BOUNDS, maxBytes: 8 }));

		expect(refused.code).toBe("body_too_large");
	});

	/**
	 * The defence that matters, and the reason a decodable fixture is no good here.
	 *
	 * These 33 bytes declare 4097 pixels across and carry no image, so nothing can decode them. Being
	 * told they are too large is only possible if the size was read from the header first — which is
	 * the whole guard. Drop `requireDecodableSize` and this arrives as `invalid_image` from the
	 * decoder instead, which is what turns this test red.
	 */
	it("refuses a header declaring more pixels than the cap, without decoding it", async () => {
		const refused = await refusal(() => measureImage(pngHeaderClaiming(4097, 8), BOUNDS));

		expect(refused.code).toBe("image_too_large");
		expect(refused.message).toMatch(/4097x8/);
	});

	/** The same header one pixel smaller, so the refusal above is about the cap and not about the fixture. */
	it("lets a header inside the cap through to the decoder", async () => {
		const refused = await refusal(() => measureImage(pngHeaderClaiming(4096, 8), BOUNDS));

		expect(refused.code).toBe("invalid_image");
	});

	it("refuses a format this caller does not accept", async () => {
		const png = await pngOf(8, 8);

		const refused = await refusal(() => measureImage(png, { ...BOUNDS, acceptedMimeTypes: ["image/jpeg"] }));

		expect(refused.code).toBe("invalid_image");
	});
});
