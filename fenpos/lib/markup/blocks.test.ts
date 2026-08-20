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

	it("measures an EAN13 barcode", () => {
		const geometry = symbolGeometry({ kind: "BARCODE", content: "5901234123457", system: "EAN13" });
		expect(geometry.heightLines).toBeGreaterThanOrEqual(4);
	});

	it("grows a PDF417 with its content", () => {
		const short = symbolGeometry({ kind: "PDF417", content: "ORDER-1", errorLevel: 1 });
		const long = symbolGeometry({ kind: "PDF417", content: "ORDER-1|".repeat(30), errorLevel: 1 });
		expect(long.heightDots).toBeGreaterThan(short.heightDots);
	});
});
