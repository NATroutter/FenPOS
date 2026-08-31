import { describe, expect, it } from "vitest";
import { type CropperValue, clampCrop, containedRect, cropToBoxRect } from "@/components/panel/avatar-cropper";

/**
 * `clampCrop` is where every geometry decision the cropper makes actually lives — see
 * `avatar-cropper.tsx`'s own doc comment. `.test.ts`, not the `.tsx` the task brief names: this
 * repo's `vitest.config.mts` only collects `test/**\/*.test.ts`, so a `.tsx` file here would never
 * run. `clampCrop` is a pure function of two plain objects, so no JSX is needed to exercise it.
 */
describe("clampCrop", () => {
	it("keeps a square inside the image", () => {
		expect(clampCrop({ x: -10, y: -10, size: 50 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 0, size: 50 });
	});

	it("pushes a square back from the far edges", () => {
		expect(clampCrop({ x: 80, y: 80, size: 50 }, { width: 100, height: 100 })).toEqual({ x: 50, y: 50, size: 50 });
	});

	it("shrinks a square larger than the shortest side", () => {
		expect(clampCrop({ x: 0, y: 0, size: 500 }, { width: 200, height: 100 })).toEqual({ x: 0, y: 0, size: 100 });
	});

	it("returns whole pixels, because the server refuses fractions", () => {
		const clamped = clampCrop({ x: 10.4, y: 10.6, size: 30.5 }, { width: 100, height: 100 });
		expect(Number.isInteger(clamped.x)).toBe(true);
		expect(Number.isInteger(clamped.y)).toBe(true);
		expect(Number.isInteger(clamped.size)).toBe(true);
	});

	/**
	 * The brief's own case above proves rounding happens *somewhere*, but every value in it already
	 * sits inside bounds — nothing there is ever actually clamped, so an implementation that bounds
	 * `x`/`y` against the *unshrunk* `size` (reordering the two bound steps the brief specifies)
	 * would pass all four cases above unnoticed. This one forces both bound steps to fire together,
	 * on a non-square image, with fractional input on every field, so the shrunk `size` — not the
	 * raw one — is what has to feed the `x`/`y` bound:
	 *
	 * Bounding `size` to the shorter side (60) first, then `x` to `[0, 100-60] = [0,40]` and `y` to
	 * `[0, 60-60] = [0,0]`, gives `{ x: 40, y: 0, size: 60 }`. Reverse the order — bound `x`/`y`
	 * against the raw `size` (75.9) before it is shrunk — and `x` clamps to `100-75.9=24.1` and `y`
	 * clamps to `60-75.9`, a *negative* number: the square gets pushed past the top edge instead of
	 * pulled inside it, which is exactly the failure the brief's ordering note warns against.
	 */
	it("bounds x and y against the already-shrunk size, not the raw one", () => {
		expect(clampCrop({ x: 45.7, y: 12.3, size: 75.9 }, { width: 100, height: 60 })).toEqual({
			x: 40,
			y: 0,
			size: 60,
		});
	});

	/**
	 * The contract `clampCrop` exists to guarantee — every field is a whole pixel, `size` is at
	 * least 1, and the rectangle fits inside `natural` — stated once as an invariant instead of
	 * pinned to one arithmetic path per case. That is deliberate: bounding real-valued `x`/`y`
	 * against a real-valued `size` and rounding all three independently at the end (the order the
	 * task brief itself specified) can round `x` and `size` *up* past a shared edge even though the
	 * unrounded rectangle fit — an exact `.5` tie is enough. `{ x: 49.5, y: 0, size: 50.5 }` in a
	 * 100×100 image is such a tie: `size` bounds to 50.5, `x` bounds to 49.5, and independently
	 * rounding each gives `x: 50, size: 51` — 101 pixels across a 100-pixel image, a rectangle the
	 * server's `requireValidCrop` refuses outright. Every row below is a case that arithmetic like
	 * that can get wrong: the reported tie, a tie on the *shorter* axis of a non-square image (where
	 * the size-to-shorter-side shrink is also live), a size small enough to round to zero (which the
	 * server also refuses — "a crop must have a size"), and a negative, fractional origin.
	 */
	it("keeps the fit-inside-the-image invariant on inputs that land on rounding boundaries", () => {
		const cases: Array<{ value: CropperValue; natural: { width: number; height: number } }> = [
			// The exact tie the controller reproduced against the server.
			{ value: { x: 49.5, y: 0, size: 50.5 }, natural: { width: 100, height: 100 } },
			// The same tie, but on the shorter axis of a non-square image, with the size-shrink live too.
			{ value: { x: 0, y: 0.5, size: 79.5 }, natural: { width: 200, height: 80 } },
			// A size that rounds to zero, which the server refuses as having no size at all.
			{ value: { x: 5, y: 5, size: 0.4 }, natural: { width: 100, height: 100 } },
			// A negative origin with a fractional size.
			{ value: { x: -5.5, y: -3.2, size: 40.7 }, natural: { width: 100, height: 100 } },
		];

		for (const { value, natural } of cases) {
			const clamped = clampCrop(value, natural);
			expect(Number.isInteger(clamped.x)).toBe(true);
			expect(Number.isInteger(clamped.y)).toBe(true);
			expect(Number.isInteger(clamped.size)).toBe(true);
			expect(clamped.size).toBeGreaterThanOrEqual(1);
			expect(clamped.x).toBeGreaterThanOrEqual(0);
			expect(clamped.y).toBeGreaterThanOrEqual(0);
			expect(clamped.x + clamped.size).toBeLessThanOrEqual(natural.width);
			expect(clamped.y + clamped.size).toBeLessThanOrEqual(natural.height);
		}
	});
});

/**
 * `containedRect` and `cropToBoxRect` exist because the drag and the mask used to each compute this
 * mapping themselves, disagreeing with each other and with what `object-fit: cover` actually drew —
 * see `avatar-cropper.tsx`'s doc comment on `containedRect` for the reasoning behind `object-contain`
 * and why `cover` let `clampCrop` allow crops the interface could not reach or show. Both are pure
 * functions of plain objects, same as `clampCrop`, for the same reason: the geometry is what's worth
 * testing, and neither needs a DOM to be exercised.
 */
describe("containedRect", () => {
	it("computes the letterbox for a landscape image in a square box", () => {
		expect(containedRect({ width: 200, height: 100 }, { width: 100, height: 100 })).toEqual({
			offsetX: 0,
			offsetY: 25,
			scale: 0.5,
		});
	});

	it("computes the letterbox for a portrait image in a square box", () => {
		expect(containedRect({ width: 100, height: 200 }, { width: 100, height: 100 })).toEqual({
			offsetX: 25,
			offsetY: 0,
			scale: 0.5,
		});
	});

	it("has zero offset and the simple ratio for a square image — the case that passed by accident before", () => {
		expect(containedRect({ width: 100, height: 100 }, { width: 50, height: 50 })).toEqual({
			offsetX: 0,
			offsetY: 0,
			scale: 0.5,
		});
	});

	/**
	 * The defect the controller reproduced directly against the source: with the box always square
	 * (an `aspect-square` wrapper) but the image drawn with `object-cover`, the old `scaleFactor`
	 * used `natural.width / rect.width` for every drag, regardless of orientation or letterboxing.
	 * For a 200×100 image in a 100×100 box, `object-cover`'s own scale is 1 — the constraining
	 * dimension, height, maps 1:1, so one screen pixel should move the crop one natural pixel — but
	 * the old formula computed `200 / 100 = 2`: dragging at double speed. `scale` here is what a
	 * screen-pixel drag delta should be *divided by* to get the natural-pixel delta it represents
	 * (see `AvatarCropper`'s `handlePointerMove`), under the `object-contain` this component now
	 * draws with rather than `cover` — which is a different, letterbox-aware number for each
	 * orientation, not the single `natural.width`-based ratio the old code applied to both.
	 */
	it("gives the scale a screen-pixel drag delta should be divided by, for both orientations", () => {
		const landscape = containedRect({ width: 200, height: 100 }, { width: 100, height: 100 });
		expect(10 / landscape.scale).toBe(20);

		const portrait = containedRect({ width: 100, height: 200 }, { width: 100, height: 100 });
		expect(6 / portrait.scale).toBe(12);
	});
});

describe("cropToBoxRect", () => {
	it("maps a crop at the image's origin, and one at the far corner, to rectangles wholly inside the box", () => {
		const natural = { width: 200, height: 100 };
		const box = { width: 100, height: 100 };
		const size = 40;

		const nearOrigin = cropToBoxRect({ x: 0, y: 0, size }, natural, box);
		const farCorner = cropToBoxRect({ x: natural.width - size, y: natural.height - size, size }, natural, box);

		for (const rect of [nearOrigin, farCorner]) {
			expect(rect.left).toBeGreaterThanOrEqual(0);
			expect(rect.top).toBeGreaterThanOrEqual(0);
			expect(rect.left + rect.width).toBeLessThanOrEqual(box.width);
			expect(rect.top + rect.height).toBeLessThanOrEqual(box.height);
		}

		expect(nearOrigin).toEqual({ left: 0, top: 25, width: 20, height: 20 });
		expect(farCorner).toEqual({ left: 80, top: 55, width: 20, height: 20 });
	});
});
