import { readFileSync } from "node:fs";
import { Jimp } from "jimp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_JPEG_MEGAPIXELS } from "@/lib/assets/dither";
import { prisma } from "@/lib/db";
import { deviceInputSchema } from "@/lib/devices/device-service";
import { ApiError } from "@/lib/errors";
import { dotWidth } from "@/lib/markup/blocks";

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

// Only the network call is replaced. `safeUrl` is kept as the real implementation on purpose: the
// credential redaction is a thing under test here, and a stubbed one would assert nothing.
vi.mock("@/lib/assets/fetch-remote", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/assets/fetch-remote")>()),
	fetchRemoteImage,
}));

/**
 * The real dither, counted.
 *
 * `rasterFor` memoises its result, and the claim worth testing is that the expensive part does not
 * run — a blob read, a decode, a resize and an error-diffusion pass over every dot. Counting calls
 * says that directly, where a timing assertion would only say it on an idle machine.
 */
const ditherToRaster = vi.hoisted(() => vi.fn<typeof import("@/lib/assets/dither").ditherToRaster>());

vi.mock("@/lib/assets/dither", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/assets/dither")>();
	ditherToRaster.mockImplementation(actual.ditherToRaster);
	return { ...actual, ditherToRaster };
});

const {
	MAX_ASSET_BYTES,
	MAX_IMAGE_DIMENSION,
	MAX_PAPER_DOTS,
	RESERVED_ASSET_NAME,
	createAsset,
	deleteAsset,
	forgetRasters,
	importAssetFromUrl,
	listAssets,
	rasterCacheStats,
	rasterFor,
} = await import("@/lib/assets/asset-service");

/**
 * A plain grey PNG of a given size.
 *
 * Grey rather than black or white so the dither produces a mixture of set and clear bits.
 *
 * @param width pixels across
 * @param height pixels down
 * @returns the encoded PNG
 */
async function solidPng(width: number, height: number): Promise<Buffer> {
	return Buffer.from(await new Jimp({ width, height, color: 0x808080ff }).getBuffer("image/png"));
}

/**
 * Lets the microtask queue drain, so a call that has started can reach its first `await`.
 *
 * Used where the point of the test is what two overlapping calls do to each other, which needs one
 * of them to be genuinely in flight rather than merely constructed.
 */
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

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
	png[28] = 0; // interlace: none
	return png;
}

/**
 * Builds a PNG header that declares a harmless size and sets Adam7 interlacing.
 *
 * The dimensions are deliberately tiny and well inside every cap, because that is the whole shape
 * of the problem: `pngjs` bounds its inflate by the declared width and height only on the
 * non-interlaced branch. Set interlace and the declared size stops governing the allocation, so a
 * guard that reads only width and height passes this file and then hands it to an unbounded
 * `zlib.inflateSync`. Measured: 255 KB of this drove a 256 MB inflate and +524 MB of RSS.
 *
 * @returns a 16x16 PNG header with the interlace method set to Adam7
 */
function interlacedHeader(): Buffer {
	const png = headerClaiming(16, 16);
	png[28] = 1;
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

	/**
	 * The agent's bundled logo prints under this exact name (`BundledImages.NAME`) and a bundled
	 * image always wins over a synced one of the same name. `RESERVED_ASSET_NAME` is a legal slug,
	 * so nothing about its shape would otherwise stop this from being created — and if it were, the
	 * asset would be shadowed by the bundled logo and would silently never print. Refusing it here
	 * is what turns that into a message an operator can act on instead of a diagnostic that quietly
	 * lies.
	 */
	it("refuses the name reserved for the bundled logo", async () => {
		const refused = await refusal(() => createAsset(RESERVED_ASSET_NAME, PNG));

		expect(refused.code).toBe("invalid_type");
		expect(refused.message).toContain(RESERVED_ASSET_NAME);
	});

	it("refuses bytes that will not decode", async () => {
		// An ApiError rather than the decoder's own error: a bad upload is a refusal the panel can
		// word, not a server fault that reaches the operator as "check the server log".
		expect((await refusal(() => createAsset("broken", Buffer.from("nope")))).code).toBe("invalid_image");
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

		expect((await refusal(() => createAsset("wide", tooWide))).code).toBe("image_too_large");
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

	/**
	 * The bound is only worth having if the decoder then allocates according to it, and for Adam7
	 * `pngjs` does not — it takes an unbounded `zlib.inflateSync` instead. So a 16x16 declaration
	 * passes every dimension check and still drives an inflate limited only by zlib's compression
	 * ratio against the byte cap. Refusing interlacing is what puts every PNG on the bounded branch.
	 */
	it("refuses an interlaced PNG, whose declared size does not bound its decode", async () => {
		const refused = await refusal(() => createAsset("adam7", interlacedHeader()));

		expect(refused.code).toBe("invalid_image");
		expect(refused.message).toMatch(/interlac/i);
	});

	it("accepts the same header without interlacing set", async () => {
		// Pins that the refusal above is about the interlace byte and not about the fixture being
		// 33 bytes of unreadable PNG: this one fails later, in the decoder, with a different message.
		const refused = await refusal(() => createAsset("plain", headerClaiming(16, 16)));

		expect(refused.message).not.toMatch(/interlac/i);
	});

	/**
	 * The dimension cap here and the megapixel ceiling handed to the JPEG decoder are the same
	 * limit expressed twice, and they cannot import each other — `asset-service` already imports
	 * `dither`. So the relationship is asserted instead: raising the pixel cap without raising the
	 * decoder's ceiling would start refusing images this module claims to accept, inside the
	 * decoder, with a message written for neither.
	 */
	it("keeps the decoder's megapixel ceiling above the dimension cap", () => {
		expect(MAX_JPEG_MEGAPIXELS * 1_000_000).toBeGreaterThanOrEqual(MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION);
	});

	/**
	 * `MAX_PAPER_DOTS` is `dotWidth(255)` restated, for the same reason and with the same protection
	 * as the megapixel ceiling above: `asset-service` cannot import `dotWidth` without pulling
	 * bwip-js's 110 encoders in behind it. Both halves are asserted — the multiplication and the 255
	 * — because a schema that later allowed 256 columns would leave the constant quietly short of
	 * the widest paper it claims to cover, and the projection would then under-estimate.
	 */
	it("keeps the widest paper width in step with the device schema", () => {
		expect(MAX_PAPER_DOTS).toBe(dotWidth(255));
		expect(deviceInputSchema.shape.columns.safeParse(255).success).toBe(true);
		expect(deviceInputSchema.shape.columns.safeParse(256).success).toBe(false);
	});

	/**
	 * The shape no other check on this path looks at.
	 *
	 * 4x1024 is 1,106 bytes, inside the byte cap, inside 4096 a side, not interlaced, and nowhere
	 * near the JPEG decode budget — and it derives a 384x98,304 raster, measured at +439 MB
	 * resident. It has to be refused *at the store*, not just at the dither, because `rasterFor`
	 * re-derives from the stored bytes on every agent connect: one such row is a denial of service
	 * that survives a restart.
	 *
	 * The refusal is asserted to arrive as an `ApiError` from `measured`, before `ditherToRaster`
	 * is called at all — a store that admitted the row and only failed later would leave the row
	 * behind, which is the whole problem.
	 */
	it("refuses a source too tall for its width to derive a raster from", async () => {
		const tall = await solidPng(4, 1024);

		const refused = await refusal(() => createAsset("tall", tall));

		expect(refused.code).toBe("image_too_large");
		expect(refused.message).toMatch(/dots tall/);
		expect(ditherToRaster).not.toHaveBeenCalled();
	});

	/** The same gate, reached through the other door. */
	it("refuses an extreme-aspect image on import as well as on upload", async () => {
		fetchRemoteImage.mockResolvedValue(await solidPng(4, 1024));

		const refused = await refusal(() => importAssetFromUrl("tall", "https://example.test/tall.png"));

		expect(refused.message).toMatch(/dots tall/);
	});

	/**
	 * The shape the cap must not catch, and the reason `MAX_IMAGE_DIMENSION` stays at 4096: a
	 * 12 MP phone photograph is 4032x3024, which is 432 rows on 80mm paper. It is the aspect ratio
	 * that needs bounding, not the side length.
	 */
	it("still accepts a full-size phone photograph", async () => {
		const photo = await solidPng(4032, 3024);

		expect((await createAsset("photo", photo)).width).toBe(4032);
	});

	it("refuses a file whose dimensions cannot be read at all", async () => {
		// A BMP decodes perfectly well in jimp and would otherwise reach the decoder unmeasured.
		const bmp = await new Jimp({ width: 4, height: 4, color: 0xff0000ff }).getBuffer("image/bmp");

		expect((await refusal(() => createAsset("bitmap", bmp))).code).toBe("invalid_image");
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

	it("refuses the name reserved for the bundled logo without fetching anything", async () => {
		const refused = await refusal(() => importAssetFromUrl(RESERVED_ASSET_NAME, URL));

		expect(refused.code).toBe("invalid_type");
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});

	/**
	 * `fetch-remote.ts` supports a URL carrying credentials — image hosts behind Basic auth exist —
	 * and holds the line that they reach the server and nowhere else, which took that module two
	 * rounds to get right in its error messages. `sourceUrl` is provenance and is never re-fetched,
	 * so a password in it buys nothing and costs a secret sitting in a database column and a log
	 * line, which outlasts any error message.
	 */
	it("keeps URL credentials out of the stored provenance", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const asset = await importAssetFromUrl("logo", "https://alice:hunter2@images.example/logo.png");

		expect(asset.sourceUrl).toBe("https://images.example/logo.png");
		const row = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
		expect(row.sourceUrl).not.toMatch(/hunter2|alice/);
	});

	it("still fetches with the credentials it was given", async () => {
		// Redaction is for what is kept, not for the request. Stripping them here instead would
		// silently break every image host behind Basic auth.
		fetchRemoteImage.mockResolvedValue(PNG);
		const withCredentials = "https://alice:hunter2@images.example/logo.png";

		await importAssetFromUrl("logo", withCredentials);

		expect(fetchRemoteImage).toHaveBeenCalledWith(withCredentials);
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

/**
 * What happens when the pre-checks lose the race they cannot win.
 *
 * `requireNameFree` then `create`, and `findUnique` then `delete`, are two statements each, so two
 * operators acting at once can both pass the check. The database constraint is what keeps that
 * *correct*; these tests are about how it reads. Without the mapping, the loser is told to go and
 * check a server log for a situation this module has a plain word for.
 *
 * The race is produced by making the pre-check return the wrong answer, which is exactly what a
 * concurrent write does to it. Everything after that is real: a real insert against a real unique
 * constraint, and a real delete of a row that is really not there.
 */
describe("losing a concurrent write", () => {
	it("reports the unique constraint as a taken name, not a server fault", async () => {
		await createAsset("logo", PNG);
		const missed = vi.spyOn(prisma.asset, "findUnique").mockResolvedValueOnce(null as never);

		try {
			const refused = await refusal(() => createAsset("logo", PNG));

			expect(refused.code).toBe("name_taken");
			expect(refused.message).toMatch(/already an image/);
		} finally {
			missed.mockRestore();
		}
	});

	it("reports a row deleted from under it as unknown, not a server fault", async () => {
		const stale = vi.spyOn(prisma.asset, "findUnique").mockResolvedValueOnce({ id: "gone", name: "logo" } as never);

		try {
			expect((await refusal(() => deleteAsset("gone"))).code).toBe("unknown_asset");
		} finally {
			stale.mockRestore();
		}
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

	/**
	 * Memoisation, and why it is worth a test rather than being taken on trust.
	 *
	 * Every agent that connects is sent one raster per stored image per paper width, and so is every
	 * agent whenever any image or device changes. Each miss is a multi-megabyte blob read plus a
	 * decode, a resize and an error-diffusion pass over every dot, so a library of any size made an
	 * upload or a reconnect proportionally expensive.
	 *
	 * Counted at the decoder rather than timed: a timing assertion is the kind that passes on a fast
	 * machine and fails on a loaded one, and what is being claimed here is that the work does not
	 * happen at all.
	 */
	it("dithers a given image and width once, however often it is asked for", async () => {
		await createAsset("logo", PNG);
		forgetRasters();
		ditherToRaster.mockClear();

		const first = await rasterFor("logo", 384);
		const second = await rasterFor("logo", 384);

		expect(ditherToRaster).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});

	it("keeps a raster per width, since one width's dots are not another's picture", async () => {
		await createAsset("logo", PNG);
		forgetRasters();
		ditherToRaster.mockClear();

		await rasterFor("logo", 384);
		await rasterFor("logo", 504);
		await rasterFor("logo", 384);

		expect(ditherToRaster).toHaveBeenCalledTimes(2);
	});

	/**
	 * The invalidation, and the failure it prevents: a logo replaced under the same name printing as
	 * the old one until the process restarted. The key carries the row's identity and its
	 * `updatedAt`, so the new bytes cannot be reached by the old key.
	 */
	it("does not serve a stale raster after the image is replaced under the same name", async () => {
		await createAsset("logo", PNG);
		forgetRasters();
		const before = await rasterFor("logo", 384);

		const stored = await prisma.asset.findFirstOrThrow({ where: { name: "logo" }, select: { id: true } });
		await deleteAsset(stored.id);
		await createAsset("logo", await solidPng(64, 64));

		const after = await rasterFor("logo", 384);

		expect(after.heightDots).not.toBe(before.heightDots);
	});

	/**
	 * A cache that outlived its bytes would be worse than none: a deleted image must be gone.
	 *
	 * This is what forbids the obvious "optimisation" of answering from the cache before reading the
	 * row. The read looks like pure overhead on a hit — it is two integer-ish columns fetched only to
	 * build a key — but skipping it would let a deleted or replaced image keep printing.
	 */
	it("refuses an image deleted after its raster was remembered", async () => {
		await createAsset("logo", PNG);
		await rasterFor("logo", 384);

		const stored = await prisma.asset.findFirstOrThrow({ where: { name: "logo" }, select: { id: true } });
		await deleteAsset(stored.id);

		await refusal(() => rasterFor("logo", 384));
	});

	/**
	 * Callers that arrive together, which is how they actually arrive.
	 *
	 * `pushConfigToEveryAgent` fans out over every connected agent at once, so agents sharing a paper
	 * width ask for the same picture simultaneously. A cache read before the first `await` cannot help
	 * them: each one misses the cold cache and each pays a full decode, resize and error-diffusion
	 * pass. That is the "ten agents, hundreds of dithers in one event" case, and it is the one the
	 * memoisation was added for.
	 */
	it("derives once for callers that ask at the same time", async () => {
		await createAsset("logo", PNG);
		forgetRasters();
		ditherToRaster.mockClear();

		const [first, second, third] = await Promise.all([
			rasterFor("logo", 384),
			rasterFor("logo", 384),
			rasterFor("logo", 384),
		]);

		expect(ditherToRaster).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
		expect(third).toBe(first);
	});

	/**
	 * A failure must not stick to the key.
	 *
	 * The shared promise is removed whichever way it settles, so an image that could not be read once
	 * — a row deleted mid-derive, bytes that will not decode — does not leave every later caller
	 * receiving that same failure for as long as the process lives.
	 */
	it("does not let one failed derivation poison the key", async () => {
		await createAsset("logo", PNG);
		forgetRasters();

		const real = await vi.importActual<typeof import("@/lib/assets/dither")>("@/lib/assets/dither");
		ditherToRaster.mockRejectedValueOnce(new Error("the decoder fell over"));

		await expect(rasterFor("logo", 384)).rejects.toThrow("the decoder fell over");

		ditherToRaster.mockImplementation(real.ditherToRaster);
		expect((await rasterFor("logo", 384)).widthDots).toBe(384);
	});

	/**
	 * The accounting behind the eviction, asserted directly because it is invisible from outside: a
	 * counter that has drifted above what is really held looks exactly like a correct one until it
	 * starts evicting entries that were still wanted.
	 *
	 * Two derivations landing on one key is the case that drifts it. In-flight sharing normally
	 * prevents that meeting, so the sequence is staged — the first derivation is held open, the
	 * in-flight record cleared, a second one started — but the guard is in `remember` rather than in
	 * the sharing, because the accounting must not depend on every future path being careful.
	 */
	it("counts a raster once even when two derivations land on the same key", async () => {
		await createAsset("logo", PNG);
		forgetRasters();

		const real = await vi.importActual<typeof import("@/lib/assets/dither")>("@/lib/assets/dither");
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		ditherToRaster.mockImplementation(async (bytes, dots) => {
			await held;
			return real.ditherToRaster(bytes, dots);
		});

		const first = rasterFor("logo", 384);
		await tick();
		// Drops the in-flight record, so the next caller starts a derivation of its own rather than
		// joining the one already running.
		forgetRasters();
		const second = rasterFor("logo", 384);
		await tick();

		release();
		const [derived] = await Promise.all([first, second]);
		ditherToRaster.mockImplementation(real.ditherToRaster);

		expect(rasterCacheStats().entries).toBe(1);
		expect(rasterCacheStats().bytes).toBe(derived.packed.length);
	});

	/**
	 * The bound, and the eviction that keeps it.
	 *
	 * The dither is replaced with one that fabricates three-megabyte rasters, because reaching an
	 * eight-megabyte cache honestly means dithering some sixty-four million pixels — which would
	 * dominate this suite to assert a loop that only cares about byte counts. Nothing about the
	 * eviction depends on the dots being real.
	 */
	it("evicts to stay within its cap, keeping what was used most recently", async () => {
		await createAsset("logo", PNG);
		forgetRasters();

		const real = await vi.importActual<typeof import("@/lib/assets/dither")>("@/lib/assets/dither");
		const huge = 3 * 1024 * 1024;
		ditherToRaster.mockImplementation(async (_bytes, dots) => ({
			widthDots: dots,
			heightDots: 1,
			packed: Buffer.alloc(huge),
		}));
		try {
			await rasterFor("logo", 100);
			await rasterFor("logo", 200);
			// 100 is touched again, so 200 becomes the least recently used and is the one that goes.
			await rasterFor("logo", 100);
			ditherToRaster.mockClear();

			await rasterFor("logo", 300);

			expect(rasterCacheStats().entries).toBe(2);
			expect(rasterCacheStats().bytes).toBe(2 * huge);

			// A hit costs no dither; the evicted width costs one.
			await rasterFor("logo", 100);
			expect(ditherToRaster).toHaveBeenCalledTimes(1);
			await rasterFor("logo", 200);
			expect(ditherToRaster).toHaveBeenCalledTimes(2);
		} finally {
			ditherToRaster.mockImplementation(real.ditherToRaster);
			forgetRasters();
		}
	});
});
