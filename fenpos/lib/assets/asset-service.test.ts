import { readFileSync } from "node:fs";
import { Jimp } from "jimp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";

/**
 * Tests for the asset store.
 *
 * Two properties carry this module and neither is visible by looking at the panel.
 *
 * The first is that the *source* bytes are stored and the raster is derived. A raster dithered for
 * 80mm paper is 504 dots wide, and printing it on a 58mm device means downscaling dots that have
 * already been reduced to black and white — which resamples the dither noise and turns a logo into
 * mud. One install can have both widths behind a single agent, so there is no width that is correct
 * to store at. If someone ever "optimises" this by storing the raster, the first test below is what
 * says no.
 *
 * The second is that neither entry point will decode an image it has not first measured. A 140 KB
 * PNG decodes to 549 MB of bitmap at 12000x12000 — measured, not estimated — so the byte cap alone
 * bounds nothing that matters. The refusal has to happen from the file's header, before the decoder
 * is handed the bytes at all, which is why one test below feeds in a header with no image behind it
 * and expects to be told the dimensions are wrong rather than that the file could not be read.
 *
 * The remote fetch is stubbed. What it does is Task 10's subject and is tested there against its own
 * seams; what matters here is only that URL import runs the bytes through the same gate as an upload.
 */
const fetchRemoteImage = vi.hoisted(() => vi.fn<(url: string) => Promise<Buffer>>());
vi.mock("@/lib/assets/fetch-remote", () => ({ fetchRemoteImage }));

const { MAX_ASSET_BYTES, MAX_IMAGE_DIMENSION, createAsset, deleteAsset, importAssetFromUrl, listAssets, rasterFor } =
	await import("@/lib/assets/asset-service");

/** A real 128x40 PNG, the same fixture the dither tests use. */
const PNG = readFileSync("test/fixtures/logo.png");

/**
 * Builds a PNG that claims a size in its header and has no image behind it.
 *
 * Thirty-three bytes: the signature and an IHDR. Nothing can decode it, which is the point — a
 * refusal that names the dimensions proves the size was read from the header, because a
 * refusal that had needed the decoder would have said the file was unreadable instead.
 *
 * @param width the width to claim
 * @param height the height to claim
 * @returns a PNG header with no pixel data
 */
function headerClaiming(width: number, height: number): Buffer {
	const png = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
	png.writeUInt32BE(13, 8);
	png.write("IHDR", 12, "ascii");
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	png[24] = 8; // bit depth
	png[25] = 6; // RGBA
	return png;
}

/**
 * Builds a JPEG that claims a size in its frame header and has no scan behind it.
 *
 * The JPEG counterpart of {@link headerClaiming}, and it has to be built rather than truncated from
 * a real file because the size does not sit at a fixed offset: a decoder — and the guard — has to
 * walk the segments to reach it. So this puts a decoy segment in front of the frame, the way a real
 * camera file puts EXIF there, and the guard only finds the size if it steps over that correctly.
 *
 * @param width the width to claim
 * @param height the height to claim
 * @returns SOI, an APP0 segment, and an SOF0 with nothing after it
 */
function jpegHeaderClaiming(width: number, height: number): Buffer {
	const app0 = Buffer.alloc(2 + 16);
	app0.writeUInt16BE(0xffe0, 0);
	app0.writeUInt16BE(16, 2);

	const sof0 = Buffer.alloc(2 + 11);
	sof0.writeUInt16BE(0xffc0, 0);
	sof0.writeUInt16BE(11, 2);
	sof0[4] = 8; // sample precision
	sof0.writeUInt16BE(height, 5);
	sof0.writeUInt16BE(width, 7);

	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

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

beforeEach(async () => {
	await prisma.asset.deleteMany();
	fetchRemoteImage.mockReset();
});

describe("createAsset", () => {
	it("stores the source bytes, not a raster", async () => {
		const asset = await createAsset("logo", PNG);

		const row = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });

		expect(Buffer.from(row.data)).toEqual(PNG);
	});

	it("records the pixel dimensions", async () => {
		const asset = await createAsset("logo", PNG);

		expect(asset.width).toBe(128);
		expect(asset.height).toBe(40);
	});

	it("records the format the bytes actually are, not the one they claimed", async () => {
		expect((await createAsset("logo", PNG)).mimeType).toBe("image/png");
	});

	it("has no source URL when uploaded", async () => {
		expect((await createAsset("logo", PNG)).sourceUrl).toBeNull();
	});

	it("refuses a duplicate name", async () => {
		await createAsset("logo", PNG);

		expect((await refusal(() => createAsset("logo", PNG))).code).toBe("name_taken");
	});

	it("refuses a name that is not a slug", async () => {
		expect((await refusal(() => createAsset("Not A Slug", PNG))).code).toBe("invalid_type");
	});

	it("refuses bytes that will not decode", async () => {
		// An ApiError rather than the decoder's own error: a bad upload is a 400 the panel can
		// word, not a server fault that reaches the operator as "check the server log".
		await refusal(() => createAsset("broken", Buffer.from("nope")));
	});

	it("refuses a format outside PNG and JPEG", async () => {
		const gif = await new Jimp({ width: 4, height: 4, color: 0xff0000ff }).getBuffer("image/gif");

		await refusal(() => createAsset("animated", gif));
	});

	it("refuses more bytes than the upload cap", async () => {
		const tooBig = Buffer.alloc(MAX_ASSET_BYTES + 1);

		expect((await refusal(() => createAsset("huge", tooBig))).code).toBe("body_too_large");
	});

	it("accepts an image at the dimension cap", async () => {
		const atCap = await new Jimp({ width: MAX_IMAGE_DIMENSION, height: 4, color: 0x000000ff }).getBuffer("image/png");

		expect((await createAsset("wide", atCap)).width).toBe(MAX_IMAGE_DIMENSION);
	});

	it("refuses an image wider than the dimension cap", async () => {
		const tooWide = await new Jimp({ width: MAX_IMAGE_DIMENSION + 1, height: 4, color: 0x000000ff }).getBuffer(
			"image/png",
		);

		expect((await refusal(() => createAsset("wide", tooWide))).code).toBe("invalid_type");
	});

	/**
	 * The decompression-bomb test, and the reason the dimension check reads the header itself.
	 *
	 * These bytes are a PNG header and nothing else, so a decoder handed them fails. Being told the
	 * image is too large is therefore only possible if the size was read before the decode was
	 * attempted — which is the whole guard. If someone moves the check to after `decodeImage`, this
	 * test reports "could not be read as an image" and fails.
	 */
	it("refuses an oversized image from its header, before decoding it", async () => {
		const bomb = headerClaiming(12_000, 12_000);

		expect((await refusal(() => createAsset("bomb", bomb))).message).toMatch(/12000/);
	});

	/**
	 * The same guard over JPEG, where the size is not at a fixed offset but behind however many
	 * EXIF, colour-profile and comment segments the camera decided to write. A guard that could only
	 * measure PNG would refuse every photograph, which is most of what gets uploaded.
	 */
	it("accepts a JPEG, measuring it past its leading segments", async () => {
		const jpeg = await new Jimp({ width: 64, height: 24, color: 0x336699ff }).getBuffer("image/jpeg");

		const asset = await createAsset("photo", jpeg);

		expect(asset.mimeType).toBe("image/jpeg");
		expect([asset.width, asset.height]).toEqual([64, 24]);
	});

	it("refuses an oversized JPEG from its frame header, before decoding it", async () => {
		const bomb = jpegHeaderClaiming(9_000, 9_000);

		expect((await refusal(() => createAsset("bomb", bomb))).message).toMatch(/9000x9000/);
	});

	it("refuses a file whose dimensions cannot be read at all", async () => {
		// A BMP decodes perfectly well in jimp and would otherwise reach the decoder unmeasured.
		const bmp = await new Jimp({ width: 4, height: 4, color: 0xff0000ff }).getBuffer("image/bmp");

		await refusal(() => createAsset("bitmap", bmp));
	});
});

describe("importAssetFromUrl", () => {
	const URL = "https://images.example/logo.png";

	it("stores what the fetch returned, with the URL for provenance", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const asset = await importAssetFromUrl("logo", URL);

		expect(asset.sourceUrl).toBe(URL);
		const row = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
		expect(Buffer.from(row.data)).toEqual(PNG);
	});

	/**
	 * The remote cap bounds the bytes downloaded; it says nothing about what they decode to. The
	 * same gate an upload passes has to apply here, or the URL becomes the way around it.
	 */
	it("applies the dimension cap to fetched bytes too", async () => {
		fetchRemoteImage.mockResolvedValue(headerClaiming(12_000, 12_000));

		expect((await refusal(() => importAssetFromUrl("bomb", URL))).message).toMatch(/12000/);
	});

	it("refuses a duplicate name without fetching anything", async () => {
		await createAsset("logo", PNG);

		expect((await refusal(() => importAssetFromUrl("logo", URL))).code).toBe("name_taken");
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});

	it("refuses a name that is not a slug without fetching anything", async () => {
		await refusal(() => importAssetFromUrl("Not A Slug", URL));

		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});

	it("reports what the fetch refused", async () => {
		fetchRemoteImage.mockRejectedValue(new ApiError("invalid_tag_argument", "That host is not routable."));

		expect((await refusal(() => importAssetFromUrl("logo", URL))).message).toBe("That host is not routable.");
	});
});

describe("listAssets", () => {
	it("lists nothing when there is nothing", async () => {
		expect(await listAssets()).toEqual([]);
	});

	it("lists by name", async () => {
		await createAsset("zebra", PNG);
		await createAsset("aardvark", PNG);

		expect((await listAssets()).map((asset) => asset.name)).toEqual(["aardvark", "zebra"]);
	});

	it("does not carry the bytes", async () => {
		await createAsset("logo", PNG);

		// The Assets tab renders a table of names and sizes; shipping every image's bytes into a
		// server component's payload to do that would grow the page by the whole asset library.
		expect(Object.keys((await listAssets())[0])).not.toContain("data");
	});
});

describe("deleteAsset", () => {
	it("removes the asset", async () => {
		const asset = await createAsset("logo", PNG);

		await deleteAsset(asset.id);

		expect(await listAssets()).toEqual([]);
	});

	it("frees the name for reuse", async () => {
		const asset = await createAsset("logo", PNG);
		await deleteAsset(asset.id);

		await expect(createAsset("logo", PNG)).resolves.toBeDefined();
	});

	it("refuses an id that is not there", async () => {
		await refusal(() => deleteAsset("nope"));
	});
});

describe("rasterFor", () => {
	it("dithers to the requested width", async () => {
		await createAsset("logo", PNG);

		expect((await rasterFor("logo", 384)).widthDots).toBe(384);
	});

	/**
	 * The point of storing the source. Both widths come off the same stored bytes, each dithered at
	 * the size it will print; neither is a rescale of the other.
	 */
	it("dithers the same source at both paper widths", async () => {
		await createAsset("logo", PNG);

		expect((await rasterFor("logo", 384)).widthDots).toBe(384);
		expect((await rasterFor("logo", 504)).widthDots).toBe(504);
	});

	it("refuses a name that is not stored", async () => {
		await refusal(() => rasterFor("absent", 384));
	});
});
