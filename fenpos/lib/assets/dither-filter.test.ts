import { describe, expect, it } from "vitest";
import { ditherFilterFor } from "@/lib/assets/dither-filter";

/**
 * Tests for the rule that picks a dithered raster's resampling filter.
 *
 * The rule exists because the browser has no way to express it: `pixelated` is nearest-neighbour in
 * both directions, and nearest-neighbour is the right answer in only one of them. Shrinking a
 * dither with it samples a deliberately high-frequency pattern below Nyquist and returns moiré —
 * measured on this codebase, the Assets card drew a 384-dot raster at 192 px and discarded three
 * dots in four, which is what made a photograph look like static.
 */
describe("ditherFilterFor", () => {
	it("smooths when the raster is drawn smaller than its dots", () => {
		// Averaging dots is what the paper does optically: at 203 dpi a dot is about 0.125 mm, under
		// what an eye resolves at reading distance, so the grey is the picture rather than a loss of it.
		expect(ditherFilterFor({ widthDots: 384, heightDots: 512 }, { widthPx: 192, heightPx: 256 })).toBe("auto");
	});

	it("keeps dots crisp at exactly one screen pixel per dot", () => {
		expect(ditherFilterFor({ widthDots: 384, heightDots: 384 }, { widthPx: 384, heightPx: 384 })).toBe("pixelated");
	});

	it("keeps dots crisp when the raster is enlarged", () => {
		// A small stored image stretched up to the card: here the dots are the subject, and smoothing
		// would blur the only thing worth looking at.
		expect(ditherFilterFor({ widthDots: 100, heightDots: 100 }, { widthPx: 278, heightPx: 278 })).toBe("pixelated");
	});

	it("smooths a hair under one-to-one", () => {
		expect(ditherFilterFor({ widthDots: 384, heightDots: 384 }, { widthPx: 383.5, heightPx: 383.5 })).toBe("auto");
	});

	it("smooths when only one axis is shrunk", () => {
		// A dot dropped along either axis is a dot dropped. The Tools sheet stretches an image by the
		// two scales its character grid disagrees by, so its axes routinely differ.
		expect(ditherFilterFor({ widthDots: 384, heightDots: 384 }, { widthPx: 512, heightPx: 192 })).toBe("auto");
		expect(ditherFilterFor({ widthDots: 384, heightDots: 384 }, { widthPx: 192, heightPx: 512 })).toBe("auto");
	});

	it("smooths a tall raster letterboxed inside a wider box", () => {
		// `object-contain` fits by the tighter axis, so a tall narrow image is drawn far smaller than
		// the box it sits in. Judging by width alone would call this an enlargement and keep the
		// nearest-neighbour speckle on an image that is in fact being shrunk by a third.
		expect(ditherFilterFor({ widthDots: 200, heightDots: 400 }, { widthPx: 278, heightPx: 256 })).toBe("auto");
	});

	it("smooths the sizes both preview surfaces actually use", () => {
		// Measured in the running panel: the Assets card, then the Tools sheet with its stretch.
		expect(ditherFilterFor({ widthDots: 384, heightDots: 384 }, { widthPx: 256, heightPx: 256 })).toBe("auto");
		expect(ditherFilterFor({ widthDots: 504, heightDots: 672 }, { widthPx: 277, heightPx: 487 })).toBe("auto");
	});

	it("smooths before anything has been measured", () => {
		// `naturalWidth` is 0 until the image decodes and a bounding box is 0 before layout. Guessing
		// `pixelated` there would show the static this rule exists to prevent, on first paint, every time.
		expect(ditherFilterFor({ widthDots: 0, heightDots: 0 }, { widthPx: 0, heightPx: 0 })).toBe("auto");
		expect(ditherFilterFor({ widthDots: 384, heightDots: 384 }, { widthPx: 0, heightPx: 0 })).toBe("auto");
		expect(ditherFilterFor({ widthDots: 0, heightDots: 0 }, { widthPx: 278, heightPx: 278 })).toBe("auto");
	});

	it("smooths rather than trusting a measurement that is not a number", () => {
		expect(ditherFilterFor({ widthDots: Number.NaN, heightDots: 384 }, { widthPx: 278, heightPx: 278 })).toBe("auto");
		expect(ditherFilterFor({ widthDots: 384, heightDots: 384 }, { widthPx: Number.NaN, heightPx: 278 })).toBe("auto");
		expect(
			ditherFilterFor({ widthDots: 384, heightDots: 384 }, { widthPx: Number.POSITIVE_INFINITY, heightPx: 278 }),
		).toBe("auto");
	});
});
