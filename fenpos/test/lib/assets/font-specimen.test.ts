import { describe, expect, it } from "vitest";
import { fontSpecimenPngDataUrl, SPECIMEN_TEXT } from "@/lib/assets/font-specimen";
import { bundledFace } from "@/lib/raster/fonts";

/**
 * The specimen is what a card shows before an operator reads a single letter of the name: it has to
 * prove the face actually renders, at the size the card renders it. The bundled face stands in for
 * an uploaded one — both are `FontFace`s from the same `parseFace`, so nothing here is special about
 * being bundled.
 */
describe("fontSpecimenPngDataUrl", () => {
	it("renders a PNG data URI at the paper width", async () => {
		const url = await fontSpecimenPngDataUrl(bundledFace(), 384);

		expect(url.startsWith("data:image/png;base64,")).toBe(true);
		expect(url.length).toBeGreaterThan(200);
	});

	it("wraps the specimen onto more than one row at a narrow width", async () => {
		// The full sentence at 24 dots comfortably outruns 96 dots, so a specimen that did not wrap
		// would come back cropped rather than reflowed onto a second line.
		const narrow = await fontSpecimenPngDataUrl(bundledFace(), 96);
		const wide = await fontSpecimenPngDataUrl(bundledFace(), 384);

		expect(narrow.length).toBeGreaterThan(0);
		expect(narrow).not.toBe(wide);
	});

	it("carries the same sentence documented as the specimen text", () => {
		expect(SPECIMEN_TEXT).toBe("The quick brown fox jumps over the lazy dog 0123456789");
	});
});
