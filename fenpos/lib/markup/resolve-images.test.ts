import { readFileSync } from "node:fs";
import { Jimp, JimpMime } from "jimp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { compiledJobSchema, IMAGE_LIMITS } from "@/lib/link/protocol";
import { type CompileSettings, compile, readRequest } from "@/lib/markup/compiler";
import { setSetting } from "@/lib/settings/settings-service";

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
const { maxRemoteReferences, RESOLVE_WINDOW, resolveImages } = await import("@/lib/markup/resolve-images");

/**
 * The `images.maxRemoteReferences` fallback (`settings-service.ts`), for tests that leave it unset.
 *
 * Read inside `beforeAll` rather than at module scope: this module's top-level code runs during
 * import, before the setup file's own `beforeAll` has migrated the test database, and a settings
 * read that early finds no `settings` table at all.
 */
let MAX_REMOTE_IMAGES: number;

beforeAll(async () => {
	MAX_REMOTE_IMAGES = await maxRemoteReferences();
});

/**
 * The device these resolves are for: 42 columns, which is 504 dots of paper.
 *
 * The width matters because it is what a stored asset's synced raster was dithered at, and so what
 * decides whether a tag needs dots of its own. Named here so the cases below can say 504 and 252 and
 * be read against it.
 */
const COLUMNS = 42;
const PAPER_DOTS = 504;

/** Resolves for {@link COLUMNS}, which is what almost every case here wants. */
const resolve = (data: string[]) => resolveImages(data, COLUMNS);

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
 * A plain grey PNG of a given size.
 *
 * Grey rather than white so the dither leaves a mixture of set and clear bits, and so nothing here
 * passes by accident on an all-zero buffer.
 *
 * @param width pixels across
 * @param height pixels down
 * @returns the encoded PNG
 */
async function solidPng(width: number, height: number): Promise<Buffer> {
	return Buffer.from(await new Jimp({ width, height, color: 0x808080ff }).getBuffer(JimpMime.png));
}

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
		await resolve(data);
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(ApiError);
		return thrown as ApiError;
	}
	throw new Error("expected a refusal, got a success");
}

beforeEach(async () => {
	await prisma.asset.deleteMany();
	// Cleared here too: the remote-limit tests below override `images.maxRemoteReferences`, and
	// need to know they are starting from the built-in default rather than whatever a previous test
	// — or another suite sharing this worker's database — left behind.
	await prisma.setting.deleteMany({ where: { key: "images.maxRemoteReferences" } });
	fetchRemoteImage.mockReset();
});

describe("resolveImages", () => {
	it("resolves a stored asset to the dimensions it was stored with", async () => {
		await createAsset("logo", PNG);

		const images = await resolve(["<image>logo</image>"]);

		expect(images.get("logo")).toMatchObject({ width: 128, height: 40 });
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});

	it("resolves a URL through the guarded fetch, keeping its query string", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolve(["<image=50>https://x.test/l.png?v=2</image>"]);

		expect(fetchRemoteImage).toHaveBeenCalledWith("https://x.test/l.png?v=2");
		expect(images.get("https://x.test/l.png?v=2")).toMatchObject({ width: 128, height: 40 });
	});

	it("looks a reference up once however many times a receipt writes it", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolve(["<image>https://x.test/l.png</image>", "<image=50>https://x.test/l.png</image>"]);

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

		const images = await resolve(remoteImages(MAX_REMOTE_IMAGES));

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

		const images = await resolve(remoteImages(MAX_REMOTE_IMAGES));

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

	/**
	 * The cap this task turned into a setting. `2` is well below the built-in fallback, so this
	 * proves the *configured* value is what is enforced rather than the default surviving underneath
	 * it.
	 */
	it("refuses more distinct remote images than configured", async () => {
		await setSetting("images.maxRemoteReferences", 2);

		const thrown = await refusal(remoteImages(3));

		expect(thrown.code).toBe("too_many_remote_images");
		expect(thrown.details).toMatchObject({ limit: 2, seen: 3 });
	});

	/**
	 * Zero is not merely a very small limit — it is the deliberate way to switch outbound image
	 * fetching off an install entirely, which is a security posture an operator may choose. The
	 * refusal has to say so: "you may reference at most 0 images" reads as this server being broken,
	 * not as a choice someone made.
	 */
	it("disables remote images entirely at zero", async () => {
		await setSetting("images.maxRemoteReferences", 0);

		const thrown = await refusal(remoteImages(1));

		expect(thrown.code).toBe("too_many_remote_images");
		expect(thrown.message).toMatch(/switched off/i);
		expect(thrown.message).not.toMatch(/at most 0/i);
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});

	it("counts distinct references, so one URL on every copy of a receipt is one image", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolve(
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

		const images = await resolve(names.map((name) => `<image>${name}</image>`));

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

		const thrown = await refusal(["<image>https://x.test/page.html</image>"]);

		// `invalid_image` rather than the `invalid_type` this once reported: bytes that will not
		// decode are a fault in the receipt's content, not in the shape of the request, so they
		// carry 422 with every other content failure rather than 400 with the envelope checks.
		expect(thrown.code).toBe("invalid_image");
		expect(thrown.status).toBe(422);
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

		const images = await resolve(["<bold>unclosed", "<image>logo</image>"]);

		expect(images.get("logo")).toMatchObject({ width: 128, height: 40 });
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});

	/**
	 * Tag names are matched case-insensitively, and the cheap scan that decides which elements are
	 * worth parsing has to agree with the parser about that. An element skipped by mistake would
	 * reach the compiler unresolved, which is a fault rather than a receipt.
	 */
	it("resolves a tag written in capitals, which the parser accepts", async () => {
		await createAsset("logo", PNG);

		expect((await resolve(["<ALIGN=CENTER><IMAGE=50>logo</IMAGE></ALIGN>"])).get("logo")).toMatchObject({
			width: 128,
			height: 40,
		});
	});

	it("resolves nothing at all for a receipt with no images", async () => {
		const images = await resolve(["Kahvi 2.50", "<qr>https://x.test/o/1</qr>"]);

		expect(images.size).toBe(0);
		expect(fetchRemoteImage).not.toHaveBeenCalled();
	});
});

/**
 * The dots, as distinct from the dimensions.
 *
 * An agent already holds a raster for every stored asset at each of its paper widths, so the common
 * case costs nothing here. Everything else has to be dithered before the compile, because the
 * compile is synchronous and dithering is not — which makes this the only place it can happen.
 */
describe("dots that have to travel with the job", () => {
	it("leaves a stored image at the paper's width to the raster the agent was already sent", async () => {
		await createAsset("logo", PNG);

		const images = await resolve(["<image>logo</image>"]);

		expect(images.get("logo")?.inline?.size).toBe(0);
	});

	/**
	 * Half the paper is not a width anything synced, and shrinking a raster on the agent would
	 * resample dots already reduced to black and white. So these are dithered here instead.
	 */
	it("dithers a stored image at a width nobody synced", async () => {
		await createAsset("logo", PNG);

		const images = await resolve(["<image=50>logo</image>"]);

		expect(images.get("logo")?.inline?.get(PAPER_DOTS / 2)?.widthDots).toBe(PAPER_DOTS / 2);
	});

	/**
	 * The measurement and the dots come out of the same fetch. Before this they did not: the size
	 * was read and the bytes dropped, so printing a URL image went to the host once to measure it and
	 * again for its pixels.
	 */
	it("dithers a URL image from the bytes it already fetched, rather than fetching twice", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolve(["<image>https://x.test/l.png</image>"]);

		expect(fetchRemoteImage).toHaveBeenCalledTimes(1);
		expect(images.get("https://x.test/l.png")?.inline?.get(PAPER_DOTS)?.widthDots).toBe(PAPER_DOTS);
	});

	it("dithers a URL image once per distinct width the receipt prints it at", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolve([
			"<image>https://x.test/l.png</image>",
			"<image=50>https://x.test/l.png</image>",
			"<image=50>https://x.test/l.png</image>",
		]);

		expect(fetchRemoteImage).toHaveBeenCalledTimes(1);
		expect([...(images.get("https://x.test/l.png")?.inline?.keys() ?? [])].sort((a, b) => a - b)).toEqual([
			PAPER_DOTS / 2,
			PAPER_DOTS,
		]);
	});

	/**
	 * The bound that keeps a compiled job sendable. A job is one WebSocket message with a hard byte
	 * cap, so a receipt whose dots exceed what the frame can hold has to be refused as a request —
	 * with the tag named — rather than accepted, recorded, and then found unsendable.
	 *
	 * Two tall images, either of which fits alone. Asserted that way on purpose: a per-image check
	 * would pass both, and the frame would still be one nothing could send.
	 */
	it("refuses a receipt whose images together exceed what one job can carry", async () => {
		fetchRemoteImage.mockResolvedValue(await solidPng(504, 1400));

		const thrown = await refusal(["<image>https://x.test/one.png</image>", "<image>https://x.test/two.png</image>"]);

		expect(thrown.code).toBe("image_too_large");
		expect(thrown.details.line).toBe(2);
	});

	/**
	 * The *other* image limit, which this budget does not imply.
	 *
	 * There are two, and only one was checked here. `MAX_INLINE_IMAGE_CHARS` bounds what a whole
	 * request may spend; `IMAGE_LIMITS.maxRasterChars` bounds any single raster, and both
	 * `imageSourceSchema` and the agent's `FrameCodec.readRaster` enforce it. The image below sits in
	 * the gap: 504x1600 dots is about 134 KB of base64, past the 128 KB per-raster cap and inside the
	 * 192 KB request allowance. It used to compile, be recorded as a job, and then fail serialisation
	 * with a `ZodError` — a 500 for the caller and a job stuck at `QUEUED`.
	 *
	 * Both bounds are asserted, because a check that had simply been tightened to the per-raster cap
	 * would pass the first of these and break the second: two images of 100 KB each are lawful
	 * individually and unlawful together.
	 */
	it("refuses a single raster larger than the wire will carry, even inside the request budget", async () => {
		fetchRemoteImage.mockResolvedValue(await solidPng(504, 1600));

		const thrown = await refusal(["<image>https://x.test/tall.png</image>"]);

		expect(thrown.code).toBe("image_too_large");
		expect(thrown.details.limit).toBe(IMAGE_LIMITS.maxRasterChars);
		expect(thrown.details.line).toBe(1);
	});

	it("still allows a raster just inside the per-raster cap", async () => {
		// The edge in the other direction: a guard that refused a lawful raster would be its own bug.
		fetchRemoteImage.mockResolvedValue(await solidPng(504, 1400));

		const images = await resolve(["<image>https://x.test/l.png</image>"]);

		expect(images.get("https://x.test/l.png")?.inline?.get(PAPER_DOTS)?.heightDots).toBe(1400);
	});

	it("charges nothing against that budget for a stored image at the paper's width", async () => {
		await createAsset("logo", await solidPng(504, 900));

		const images = await resolve(Array.from({ length: 20 }, () => "<image>logo</image>"));

		expect(images.get("logo")?.inline?.size).toBe(0);
	});

	/**
	 * The width a raster is keyed by is the printed width in dots, so it follows the device rather
	 * than the tag. The same receipt on narrower paper needs a different raster, and asking for the
	 * one it does not need would be a silently wrong picture.
	 */
	it("keys a raster by the printed width, which follows the device's paper", async () => {
		fetchRemoteImage.mockResolvedValue(PNG);

		const images = await resolveImages(["<image>https://x.test/l.png</image>"], 32);

		expect([...(images.get("https://x.test/l.png")?.inline?.keys() ?? [])]).toEqual([384]);
	});

	/**
	 * The reserved name, which is the application's own logo and not an asset at all.
	 *
	 * Until this existed, previewing the Tools tab's own "Device test page" example reported
	 * `unknown_asset` on the line that prints the logo — the panel had no way to reach the rasters
	 * bundled in the agent's jar. It resolves from `public/fenpos-logo.png` instead, through the
	 * same ditherer, and `bundled-logo.test.ts` is what pins those dots to the agent's committed
	 * ones.
	 */
	describe("the bundled logo", () => {
		it("resolves the reserved name without anything being stored under it", async () => {
			const images = await resolve(["<image>fenpos</image>"]);

			const logo = images.get("fenpos");
			expect(logo?.width).toBeGreaterThan(0);
			expect(logo?.height).toBeGreaterThan(0);
			expect(fetchRemoteImage).not.toHaveBeenCalled();
		});

		/**
		 * **Inline rather than a REF, on purpose.** A REF would have the agent print the logo out of
		 * its own jar, so a panel and an agent built at different times would print one logo and
		 * preview another with nothing to say so. The dots that were previewed are the dots that
		 * are sent.
		 */
		it("carries its dots inside the job rather than naming a raster on the agent", async () => {
			const images = await resolve(["<image>fenpos</image>"]);

			// 504 is this device's own paper width — the case a stored asset would answer with a
			// REF and no dots at all.
			expect([...(images.get("fenpos")?.inline?.keys() ?? [])]).toEqual([PAPER_DOTS]);
			expect(images.get("fenpos")?.inline?.get(PAPER_DOTS)?.widthDots).toBe(PAPER_DOTS);
		});

		/**
		 * A row under the reserved name cannot be created through `createAsset`, but one committed
		 * before the name was reserved could still be sitting in a database. The logo is resolved
		 * before anything is looked up, so such a row changes nothing.
		 */
		it("wins over a row that predates the name being reserved", async () => {
			await prisma.asset.create({
				data: { kind: "IMAGE", name: "fenpos", mimeType: "image/png", width: 128, height: 40, data: PNG },
			});

			const images = await resolve(["<image>fenpos</image>"]);

			// The stored row is 128x40. The logo is not, so the answer is demonstrably not the row's.
			expect(images.get("fenpos")).not.toMatchObject({ width: 128, height: 40 });
		});

		/**
		 * The agent matches a bundled width exactly and never scales, so the panel refuses every
		 * other width rather than previewing a picture the paper cannot carry.
		 */
		it("refuses a width the agent bundles nothing for, naming the element", async () => {
			const thrown = await refusal(["Kahvi 2.50", "<image=50>fenpos</image>"]);

			expect(thrown.code).toBe("unbundled_logo_width");
			expect(thrown.details.line).toBe(2);
		});

		/**
		 * The decision, checked through the compile rather than argued for in a comment: the job an
		 * agent is handed carries the logo's dots. A `REF` would name the agent's own bundle, and
		 * an agent built from a different commit would then print a logo the preview never showed.
		 */
		it("compiles to a job carrying the dots, not a REF into the agent's bundle", async () => {
			const images = await resolve(["<image>fenpos</image>"]);
			const settings: CompileSettings = {
				columns: COLUMNS,
				codepage: "CP858",
				onUnsupported: "REJECT",
				defaultWrap: true,
				defaultLinefeed: "LF",
				images,
			};
			const limits = { maxLines: 5, maxLineChars: 60, maxTotalChars: 200, maxOutputLines: 400 };

			const request = readRequest({ data: ["<image>fenpos</image>"], linefeed: "LF" }, limits, settings);
			const job = compile("job-1", "kitchen", request, limits, settings);

			expect(compiledJobSchema.safeParse(job).success).toBe(true);
			expect(job.lines[0].directives[0]).toMatchObject({
				type: "IMAGE",
				source: {
					kind: "INLINE",
					widthDots: PAPER_DOTS,
					data: images.get("fenpos")?.inline?.get(PAPER_DOTS)?.packed.toString("base64"),
				},
			});
		});

		it("still reports a genuinely missing asset as unknown_asset", async () => {
			const thrown = await refusal(["<image>fenpos-logo</image>"]);

			expect(thrown.code).toBe("unknown_asset");
			expect(thrown.message).toContain("fenpos-logo");
		});
	});
});
