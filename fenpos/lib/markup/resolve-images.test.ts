import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";

/**
 * Tests for the pre-pass that gives the compiler an image's dimensions.
 *
 * Three properties are worth the file. The first is that a reference is looked up exactly once
 * however many times a receipt writes it, because the remote case is a network round trip on the
 * request path and a receipt may repeat a logo on every copy.
 *
 * The second is that a URL reaching this module goes through `fetchRemoteImage` and then through
 * the *same* decode gate an upload does. Both are load-bearing: the first is the SSRF guard, and
 * skipping the second would mean the one image path that does not come from a signed-in operator is
 * also the one that hands unmeasured bytes to a decoder.
 *
 * The third is that markup which does not parse never causes a fetch. An unclosed tag is a 400 that
 * the compile is about to raise anyway, and a broken receipt has no business making this server open
 * a connection.
 *
 * The fetch itself is stubbed. What it does is `fetch-remote.ts`'s subject and is tested there
 * against its own seams; what matters here is only which references reach it.
 */
const fetchRemoteImage = vi.hoisted(() => vi.fn<(url: string) => Promise<Buffer>>());

vi.mock("@/lib/assets/fetch-remote", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/assets/fetch-remote")>()),
	fetchRemoteImage,
}));

const { createAsset } = await import("@/lib/assets/asset-service");
const { resolveImages } = await import("@/lib/markup/resolve-images");

/** A real 128x40 PNG, the same fixture the dither and asset tests use. */
const PNG = readFileSync("test/fixtures/logo.png");

/**
 * Builds a PNG that claims a size in its header and has no image behind it.
 *
 * Nothing can decode it, which is the point: a refusal naming the dimensions proves the size was
 * read from the header, because one that had needed the decoder would have said the file was
 * unreadable instead.
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
 * Runs a resolve expected to fail and returns the `ApiError` it raised.
 *
 * @param data the elements to resolve
 * @returns the error, having asserted it is an ApiError
 */
async function refusal(data: string[]): Promise<ApiError> {
	try {
		await resolveImages(data);
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

describe("resolveImages", () => {
	it("resolves a stored asset to the dimensions it was stored with", async () => {
		await createAsset("logo", PNG);

		const images = await resolveImages(["<image>logo</image>"]);

		expect(images.get("logo")).toEqual({ width: 128, height: 40 });
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});

	it("resolves a URL through the guarded fetch, keeping its query string", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolveImages(["<image=50>https://x.test/l.png?v=2</image>"]);

		expect(fetchRemoteImage).toHaveBeenCalledWith("https://x.test/l.png?v=2");
		expect(images.get("https://x.test/l.png?v=2")).toEqual({ width: 128, height: 40 });
	});

	it("looks a reference up once however many times a receipt writes it", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolveImages([
			"<image>https://x.test/l.png</image>",
			"<image=50>https://x.test/l.png</image>",
		]);

		expect(fetchRemoteImage).toHaveBeenCalledTimes(1);
		expect(images.size).toBe(1);
	});

	it("refuses an image nobody has stored, naming the element it was written on", async () => {
		const thrown = await refusal(["Kahvi 2.50", "<image>missing</image>"]);

		expect(thrown.code).toBe("unknown_asset");
		expect(thrown.message).toContain("missing");
		expect(thrown.details.line).toBe(2);
	});

	/**
	 * The guard that matters most here. A URL image is the only image in this system that was not
	 * chosen by a signed-in operator, so it must not be the one that reaches the decoder unmeasured.
	 */
	it("puts a URL image through the same size gate as an upload", async () => {
		fetchRemoteImage.mockResolvedValue(headerClaiming(12000, 12000));

		const thrown = await refusal(["<image>https://x.test/bomb.png</image>"]);

		expect(thrown.message).toContain("12000x12000");
		expect(thrown.details.line).toBe(1);
	});

	it("reports bytes that are not an image as a refusal of that element", async () => {
		fetchRemoteImage.mockResolvedValue(Buffer.from("<html>not a picture</html>"));

		expect((await refusal(["<image>https://x.test/page.html</image>"])).status).toBe(400);
	});

	/**
	 * A reference carrying a scheme is a URL even when it is one this system will not fetch, so the
	 * refusal comes from the fetch guard — "only http or https" — rather than from a lookup for an
	 * asset that was never going to be called `ftp://…`. Only the routing is asserted here; what the
	 * guard then does with it belongs to `fetch-remote.test.ts`.
	 */
	it("treats anything carrying a scheme as a URL rather than an asset name", async () => {
		fetchRemoteImage.mockRejectedValue(new ApiError("invalid_tag_argument", "not http"));

		await refusal(["<image>ftp://x.test/l.png</image>"]);

		expect(fetchRemoteImage).toHaveBeenCalledWith("ftp://x.test/l.png");
	});

	it("fetches nothing for markup that does not parse, which the compile will refuse anyway", async () => {
		await createAsset("logo", PNG);

		const images = await resolveImages(["<bold>unclosed", "<image>logo</image>"]);

		expect(images.get("logo")).toEqual({ width: 128, height: 40 });
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});

	/**
	 * Tag names are matched case-insensitively, and the cheap scan that decides which elements are
	 * worth parsing has to agree with the parser about that. An element skipped by mistake would
	 * reach the compiler unresolved, which is a fault rather than a receipt.
	 */
	it("resolves a tag written in capitals, which the parser accepts", async () => {
		await createAsset("logo", PNG);

		expect((await resolveImages(["<ALIGN=CENTER><IMAGE=50>logo</IMAGE></ALIGN>"])).get("logo")).toEqual({
			width: 128,
			height: 40,
		});
	});

	it("resolves nothing at all for a receipt with no images", async () => {
		const images = await resolveImages(["Kahvi 2.50", "<qr>https://x.test/o/1</qr>"]);

		expect(images.size).toBe(0);
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});
});
