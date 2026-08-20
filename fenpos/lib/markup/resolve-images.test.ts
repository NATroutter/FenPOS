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
const { MAX_REMOTE_IMAGES, RESOLVE_WINDOW, resolveImages } = await import("@/lib/markup/resolve-images");

/**
 * A receipt naming `count` distinct URLs, one per element.
 *
 * @param count how many distinct remote images to name
 * @returns the elements
 */
function remoteImages(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `<image>https://x.test/${index}.png</image>`);
}

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

	/**
	 * The bound on what one request can make this server do at once.
	 *
	 * Without it a receipt naming every URL it is allowed to opens that many sockets, holds that
	 * many buffers of up to 2 MB each before a single one is decoded, and pays that many TLS
	 * handshakes, since the transport pools nothing. The window is what keeps that a constant.
	 *
	 * Asserted as an equality rather than an upper bound so it fails in both directions: resolving
	 * one at a time would peak at 1, and no window at all would peak at the whole receipt. The
	 * receipt is a full complement of remote images, which is why {@link MAX_REMOTE_IMAGES} has to
	 * stay above {@link RESOLVE_WINDOW} for this to be able to tell those apart.
	 */
	it("resolves at most a window of images at once, however many a receipt names", async () => {
		let inFlight = 0;
		let peak = 0;
		fetchRemoteImage.mockImplementation(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((settle) => setTimeout(settle, 5));
			inFlight--;
			return PNG;
		});

		const images = await resolveImages(remoteImages(MAX_REMOTE_IMAGES));

		expect(images.size).toBe(MAX_REMOTE_IMAGES);
		expect(fetchRemoteImage).toHaveBeenCalledTimes(MAX_REMOTE_IMAGES);
		expect(peak).toBe(RESOLVE_WINDOW);
	});

	it("stops at the first refusal instead of fetching the rest of the receipt", async () => {
		fetchRemoteImage.mockRejectedValue(new ApiError("invalid_tag_argument", "nothing answers here"));

		await refusal(remoteImages(MAX_REMOTE_IMAGES));

		expect(fetchRemoteImage.mock.calls.length).toBeLessThanOrEqual(RESOLVE_WINDOW);
	});

	/**
	 * The bound on how long one request can wait, which the window alone does not give: a window
	 * caps what is in flight, but a receipt naming enough URLs still waits one timeout per windowful.
	 * Capping the references is what turns that into a number.
	 *
	 * A wall-clock budget was the alternative and is worse: bounding the wait honestly means
	 * cancelling the fetches still running, and a budget that merely walks away from them leaves
	 * sockets and CPU in use after the caller has already been answered.
	 */
	it("resolves a receipt naming as many remote images as it may", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolveImages(remoteImages(MAX_REMOTE_IMAGES));

		expect(images.size).toBe(MAX_REMOTE_IMAGES);
		expect(fetchRemoteImage).toHaveBeenCalledTimes(MAX_REMOTE_IMAGES);
	});

	it("refuses one image beyond the limit, before opening a single connection", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const thrown = await refusal(remoteImages(MAX_REMOTE_IMAGES + 1));

		expect(thrown.code).toBe("too_many_remote_images");
		expect(thrown.details).toMatchObject({ limit: MAX_REMOTE_IMAGES, seen: MAX_REMOTE_IMAGES + 1 });
		// The whole point of checking before the workers start: refusing after the fetches are away
		// would be a limit that reports the problem while still causing it.
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});

	it("counts distinct references, so one URL on every copy of a receipt is one image", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolveImages(
			Array.from({ length: MAX_REMOTE_IMAGES + 5 }, () => "<image>https://x.test/l.png</image>"),
		);

		expect(images.size).toBe(1);
		expect(fetchRemoteImage).toHaveBeenCalledTimes(1);
	});

	/**
	 * The limit is about the network, not about images. A stored asset is a read of two integer
	 * columns with no socket, no buffer and no timeout to wait out, and the spec makes stored assets
	 * the documented default with URLs as the escape hatch — so counting them here would cap the
	 * thing this system wants people to use.
	 */
	it("does not count stored assets against the remote limit", async () => {
		const names = Array.from({ length: MAX_REMOTE_IMAGES + 1 }, (_, index) => `logo-${index}`);
		for (const name of names) {
			await createAsset(name, PNG);
		}

		const images = await resolveImages(names.map((name) => `<image>${name}</image>`));

		expect(images.size).toBe(MAX_REMOTE_IMAGES + 1);
		expect(fetchRemoteImage).not.toHaveBeenCalled();
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
