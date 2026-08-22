import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { rasterToPngDataUrl } from "@/lib/assets/preview";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { dotWidth, LINE_HEIGHT_DOTS, type SymbolSpec, symbolGeometry, symbolSvg } from "@/lib/markup/blocks";
import { imageGeometry, printedWidthDots } from "@/lib/markup/images";

/**
 * Tests for what the Tools tab's preview reports.
 *
 * The property worth pinning is that a block's size in the preview is the compiler's own
 * measurement rather than a second opinion that happens to agree. Everything else about a preview
 * can be checked by looking at it; this cannot, because two numbers that disagree by a line look
 * exactly like two numbers that agree until a receipt is one line too long to print.
 *
 * For an image there is a second such property: the dots. A preview that scaled the stored picture
 * would look better than the paper, which is the one thing a preview may not do — so what it carries
 * has to be the raster the printer is sent, not a rendering of the original.
 *
 * The session guard is stubbed rather than satisfied: it redirects, and a redirect is not what
 * these tests are about. Everything downstream of it is the real pipeline against a real database.
 *
 * The remote fetch is stubbed for the same reason `resolve-images.test.ts` stubs it: what it does is
 * `fetch-remote.ts`'s subject. What matters here is that a URL in the editor reaches *it* rather
 * than some second fetch written for the preview's convenience.
 */
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => {},
}));

const fetchRemoteImage = vi.hoisted(() => vi.fn<(url: string) => Promise<Buffer>>());

vi.mock("@/lib/assets/fetch-remote", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/assets/fetch-remote")>()),
	fetchRemoteImage,
}));

const { preview } = await import("@/app/(panel)/tools/actions");
const { createAsset, rasterFor } = await import("@/lib/assets/asset-service");

const QR_CONTENT = "https://cafe.example/o/123";

/** The width of the printer these previews are compiled against. */
const COLUMNS = 32;

/** A real 128x40 PNG, the same fixture the dither and asset tests use. */
const LOGO = readFileSync("test/fixtures/logo.png");

/** The stored image these previews name. Its own name, so no other test file's clean-up reaches it. */
const ASSET = "preview-logo";

/**
 * The block a symbol should arrive as, drawn and measured from the shared module.
 *
 * Built from `blocks.ts` rather than from literals: the property under test is that the preview
 * reports what that module says, so restating its answers here would only pin them to themselves.
 *
 * @param spec the symbol
 * @returns the block the preview should carry for it
 */
function drawn(spec: SymbolSpec) {
	const geometry = symbolGeometry(spec);
	return {
		kind: "SYMBOL",
		spec,
		svg: symbolSvg(spec),
		heightLines: geometry.heightLines,
		widthFraction: geometry.widthDots / dotWidth(COLUMNS),
	};
}

/**
 * The block a stored image should arrive as, dithered by the module the printer's own dots come
 * from.
 *
 * Built from `rasterFor` and `rasterToPngDataUrl` for the same reason {@link drawn} is built from
 * `blocks.ts`: the property under test is that the preview carries what those produce. A PNG
 * restated here would pin the preview to this file's idea of a dither instead of to the printer's.
 *
 * @param widthPercent the share of the paper the tag asks for
 * @param columns the printer's width
 * @returns the block the preview should carry
 */
async function dithered(widthPercent: number, columns: number) {
	const raster = await rasterFor(ASSET, printedWidthDots(widthPercent, columns));
	return {
		kind: "IMAGE",
		ref: ASSET,
		png: await rasterToPngDataUrl(raster),
		heightLines: Math.ceil(raster.heightDots / LINE_HEIGHT_DOTS),
		inkedLines: raster.heightDots / LINE_HEIGHT_DOTS,
		widthFraction: raster.widthDots / dotWidth(columns),
	};
}

describe("preview", () => {
	let deviceId = "";
	let agentId = "";

	beforeAll(async () => {
		const agent = await prisma.agent.create({ data: { name: `preview-${process.pid}` } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "counter", port: "COM1", columns: COLUMNS },
		});
		agentId = agent.id;
		deviceId = device.id;

		await createAsset(ASSET, LOGO);
	});

	it("draws a symbol at the size the compiler charged it", async () => {
		const spec = { kind: "QR", content: QR_CONTENT, size: 6 } as const;
		const result = await preview(deviceId, `<qr>${QR_CONTENT}</qr>`);

		const charged = symbolGeometry(spec);
		expect(charged.heightLines).toBeGreaterThan(1);
		expect(result.errors).toEqual([]);
		// Its width arrives as a share of 32 columns of paper, which is the number that answers
		// whether it fits across the sheet.
		expect(result.lines?.[0].blocks).toEqual([drawn(spec)]);
		// The same number the budget is checked against, which is the whole point of carrying it.
		expect(result.outputLines).toBe(charged.heightLines);
	});

	it("measures a symbol's width against the paper it is being previewed on", async () => {
		const narrow = await prisma.device.create({
			data: { agentId: agentId, name: "narrow", port: "COM2", columns: 32 },
		});
		const wide = await prisma.device.create({
			data: { agentId: agentId, name: "wide", port: "COM3", columns: 42 },
		});

		const onNarrow = await preview(narrow.id, `<qr>${QR_CONTENT}</qr>`);
		const onWide = await preview(wide.id, `<qr>${QR_CONTENT}</qr>`);

		// The same symbol takes a smaller share of a wider printer's paper. Drawn off the vertical
		// scale instead, both would be the same size and neither would answer "does this fit".
		const narrowShare = onNarrow.lines?.[0].blocks[0].widthFraction ?? 0;
		const wideShare = onWide.lines?.[0].blocks[0].widthFraction ?? 0;
		expect(narrowShare).toBeGreaterThan(wideShare);
		expect(narrowShare / wideShare).toBeCloseTo(42 / 32, 10);
	});

	/**
	 * A symbol too wide for the paper is now refused rather than drawn overhanging it.
	 *
	 * This case used to assert the opposite — that the preview showed a `widthFraction` above 1 and
	 * left the decision to whoever was looking. That was the stated mitigation for having no
	 * refusal anywhere, and it did not hold: the figure was wrong for Code 128, measured in bwip-js's
	 * automatic code set while the agent forces set B, and it is still wrong for ITF. A marker that
	 * under-reports by 43% is not a mitigation, so the compiler refuses instead and the preview
	 * reports that refusal like any other markup error, while the markup is still being written.
	 */
	it("refuses a symbol too wide for the paper rather than drawing it overhanging", async () => {
		const result = await preview(deviceId, `<barcode=CODE128>${"ORDER-1234567890".repeat(4)}</barcode>`);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].code).toBe("symbol_too_wide");
		expect(result.errors[0].line).toBe(1);
		expect(result.lines).toBeNull();
	});

	it("still previews a symbol that fits the paper", async () => {
		// The other side of that boundary: the refusal must be about the width, not about the tag.
		const result = await preview(deviceId, "<barcode=CODE128>ORDER-1234</barcode>");

		expect(result.errors).toEqual([]);
		expect(result.lines?.[0].blocks[0].widthFraction).toBeLessThanOrEqual(1);
	});

	it("carries a symbol's own alignment, and marks it as nothing else", async () => {
		const result = await preview(deviceId, `<align=center><qr>${QR_CONTENT}</qr></align>`);

		expect(result.lines?.[0].align).toBe("CENTER");
		// A symbol is drawn, not annotated: a marker here would be a second description of a line
		// the preview already shows in full.
		expect(result.lines?.[0].marker).toBeNull();
	});

	it("charges a barcode and a PDF417 the sizes they were measured at", async () => {
		const barcode = { kind: "BARCODE", content: "5901234123457", system: "EAN13" } as const;
		const pdf417 = { kind: "PDF417", content: "ORDER-123", errorLevel: 1 } as const;

		const result = await preview(
			deviceId,
			["<barcode=EAN13>5901234123457</barcode>", "<pdf417>ORDER-123</pdf417>"].join("\n"),
		);

		expect(result.errors).toEqual([]);
		expect(result.lines?.[0].blocks).toEqual([drawn(barcode)]);
		expect(result.lines?.[1].blocks).toEqual([drawn(pdf417)]);
	});

	it("marks a drawer pulse without hiding the line it was written on", async () => {
		const result = await preview(deviceId, "Total 5.50<drawer=5>");

		expect(result.lines?.[0].marker).toBe("drawer (pin 5)");
		expect(result.lines?.[0].spans.map((span) => span.text).join("")).toBe("Total 5.50");
		// A pulse touches no paper, so it may not lengthen the receipt.
		expect(result.outputLines).toBe(1);
		expect(result.lines?.[0].blocks).toEqual([]);
	});

	it("leaves a line of text with neither a symbol nor a marker", async () => {
		const result = await preview(deviceId, "Coffee 2.50");

		expect(result.lines?.[0].blocks).toEqual([]);
		expect(result.lines?.[0].marker).toBeNull();
	});

	it("draws a stored image from the dither the printer is sent", async () => {
		const result = await preview(deviceId, `<image>${ASSET}</image>`);

		expect(result.errors).toEqual([]);
		// The whole block, including the PNG: the dots on screen are the dots that were synced to
		// the agent, so a preview that decided to scale the stored picture instead fails here.
		expect(result.lines?.[0].blocks).toEqual([await dithered(100, COLUMNS)]);
		// Drawn rather than annotated, like a symbol and unlike a cut.
		expect(result.lines?.[0].marker).toBeNull();
	});

	it("charges an image the height the compiler charged it", async () => {
		const result = await preview(deviceId, `<image>${ASSET}</image>`);

		const charged = imageGeometry({ width: 128, height: 40 }, 100, COLUMNS);
		expect(charged.heightLines).toBeGreaterThan(1);
		expect(result.lines?.[0].blocks[0].heightLines).toBe(charged.heightLines);
		expect(result.outputLines).toBe(charged.heightLines);
	});

	it("draws an image at its share of the paper's width, not of its height", async () => {
		const half = await preview(deviceId, `<image=50>${ASSET}</image>`);

		expect(half.errors).toEqual([]);
		expect(half.lines?.[0].blocks).toEqual([await dithered(50, COLUMNS)]);
		// 128x40 at half of 384 dots is 192x60 — two and a half lines of dots, charged as three.
		// Both figures travel: the block occupies the paper it was charged, and the picture inside
		// it covers only the dots it really inks. Drawn at the charged height it would be a fifth
		// taller than it prints.
		expect(half.lines?.[0].blocks[0].widthFraction).toBe(0.5);
		expect(half.lines?.[0].blocks[0]).toMatchObject({ inkedLines: 2.5, heightLines: 3 });
	});

	it("dithers an image again for the paper it is being previewed on", async () => {
		const wide = await prisma.device.create({
			data: { agentId: agentId, name: "wide-image", port: "COM4", columns: 42 },
		});

		const onNarrow = await preview(deviceId, `<image>${ASSET}</image>`);
		const onWide = await preview(wide.id, `<image>${ASSET}</image>`);

		// Full width on both, so the share of the paper is the same figure — but 384 dots of it on
		// one and 504 on the other, which is a different picture rather than the same one scaled.
		expect(onNarrow.lines?.[0].blocks[0].widthFraction).toBe(1);
		expect(onWide.lines?.[0].blocks[0].widthFraction).toBe(1);
		expect(onWide.lines?.[0].blocks).toEqual([await dithered(100, 42)]);
		expect(onWide.lines?.[0].blocks[0]).not.toEqual(onNarrow.lines?.[0].blocks[0]);
	});

	it("fetches a URL image through the guarded fetch, and shows what came back", async () => {
		fetchRemoteImage.mockResolvedValue(LOGO);

		const result = await preview(deviceId, "<image>https://x.test/logo.png</image>");

		expect(result.errors).toEqual([]);
		expect(fetchRemoteImage).toHaveBeenCalledWith(
			"https://x.test/logo.png",
			expect.objectContaining({ settings: expect.any(Object) }),
		);
		// The same bytes as the stored copy, so the same dots: what is pinned here is that the
		// preview draws the fetched image rather than reaching for a stored one of that name.
		expect(result.lines?.[0].blocks[0]).toMatchObject({
			kind: "IMAGE",
			ref: "https://x.test/logo.png",
			png: (await dithered(100, COLUMNS)).png,
		});
	});

	it("reports an unreachable URL where the markup errors go, keeping its measurements", async () => {
		fetchRemoteImage.mockRejectedValue(new ApiError("invalid_tag_argument", "x.test did not answer."));

		const result = await preview(deviceId, "<image>https://x.test/logo.png</image>");

		expect(result.lines).toBeNull();
		expect(result.errors).toEqual([expect.objectContaining({ code: "invalid_tag_argument", status: 422, line: 1 })]);
		// The footer still has something true to say about the printer it was compiled against.
		expect(result.columns).toBe(COLUMNS);
	});
});
