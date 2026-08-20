import bwip from "bwip-js/node";
import { describe, expect, it } from "vitest";
import { dotWidth, LINE_HEIGHT_DOTS, symbolGeometry, validateSymbolContent } from "@/lib/markup/blocks";

describe("dotWidth", () => {
	it("is twelve dots per column", () => {
		expect(dotWidth(42)).toBe(504);
		expect(dotWidth(32)).toBe(384);
	});
});

describe("symbolGeometry", () => {
	it("scales a QR code with its module size", () => {
		const small = symbolGeometry({ kind: "QR", content: "https://example.com/o/123", size: 4 });
		const large = symbolGeometry({ kind: "QR", content: "https://example.com/o/123", size: 8 });
		expect(large.heightDots).toBe(small.heightDots * 2);
	});

	it("grows a QR code as its content grows", () => {
		const short = symbolGeometry({ kind: "QR", content: "A", size: 6 });
		const long = symbolGeometry({ kind: "QR", content: "A".repeat(200), size: 6 });
		expect(long.heightDots).toBeGreaterThan(short.heightDots);
	});

	it("reports height in whole lines, rounded up", () => {
		const geometry = symbolGeometry({ kind: "QR", content: "https://example.com/o/123", size: 6 });
		expect(geometry.heightLines).toBe(Math.ceil(geometry.heightDots / LINE_HEIGHT_DOTS));
		expect(geometry.heightLines).toBeGreaterThan(0);
	});

	it("refuses an EAN13 that is not thirteen digits", () => {
		expect(validateSymbolContent({ kind: "BARCODE", content: "123", system: "EAN13" })).toMatch(/13/);
		expect(validateSymbolContent({ kind: "BARCODE", content: "5901234123457", system: "EAN13" })).toBeNull();
	});

	it("refuses letters in a numeric symbology", () => {
		expect(validateSymbolContent({ kind: "BARCODE", content: "ABCDEFGHIJKLM", system: "EAN13" })).not.toBeNull();
	});

	it("measures an EAN13 barcode at the spec's fixed 100-dot height", () => {
		const geometry = symbolGeometry({ kind: "BARCODE", content: "5901234123457", system: "EAN13" });
		expect(geometry.heightLines).toBe(5);
	});

	it("grows a PDF417 with its content", () => {
		const short = symbolGeometry({ kind: "PDF417", content: "ORDER-1", errorLevel: 1 });
		const long = symbolGeometry({ kind: "PDF417", content: "ORDER-1|".repeat(30), errorLevel: 1 });
		expect(long.heightDots).toBeGreaterThan(short.heightDots);
	});

	it("measures a PDF417 in the same dots-per-module scale on both axes as the encoder itself", async () => {
		const content = "ORDER-1|".repeat(30);
		const errorLevel = 1;

		// Ground truth: bwip-js's own rendered pixel dimensions at scale:1, i.e. one pixel per
		// module in both directions. If symbolGeometry scaled width and height by different
		// per-module dot constants, the two axes would stop being proportional to this render.
		// Built as a variable, not an inline literal, since `eclevel` isn't in bwip-js's typed
		// RenderOptions even though the encoder accepts it (see the same pattern in blocks.ts).
		const renderOptions = { bcid: "pdf417", text: content, eclevel: errorLevel, scale: 1, includetext: false };
		const rendered = await bwip.toBuffer(renderOptions);
		const renderedWidth = rendered.readUInt32BE(16);
		const renderedHeight = rendered.readUInt32BE(20);

		const geometry = symbolGeometry({ kind: "PDF417", content, errorLevel });
		const dotsPerModule = geometry.widthDots / renderedWidth;

		expect(geometry.heightDots).toBe(renderedHeight * dotsPerModule);
	});
});
