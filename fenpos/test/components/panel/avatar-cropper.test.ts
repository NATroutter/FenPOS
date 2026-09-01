import { describe, expect, it } from "vitest";
import { type CropperValue, clampCrop, cropToNatural } from "@/components/panel/avatar-cropper";

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
 * The seam between `react-image-crop` and the server.
 *
 * The library owns the interaction and reports a selection in percentages of the rendered element;
 * the server wants whole natural pixels and refuses anything else. This is the whole of that
 * conversion, and it is a pure function for the same reason `clampCrop` is — the repo's vitest runs
 * in a Node environment, so anything left inside the component is untestable here. An earlier,
 * hand-rolled cropper put its geometry in the component and shipped two bugs that no test in this
 * suite could see; keeping the mapping out here is the fix for that class of problem, not just for
 * those two.
 */
describe("cropToNatural", () => {
	it("converts a percentage selection into natural pixels", () => {
		// Half the width of a 200x100 picture, flush to the left edge: a 100px square.
		expect(cropToNatural({ unit: "%", x: 0, y: 0, width: 50, height: 100 }, { width: 200, height: 100 })).toEqual({
			x: 0,
			y: 0,
			size: 100,
		});
	});

	it("places a centred selection on a landscape picture", () => {
		expect(cropToNatural({ unit: "%", x: 25, y: 0, width: 50, height: 100 }, { width: 200, height: 100 })).toEqual({
			x: 50,
			y: 0,
			size: 100,
		});
	});

	it("places a centred selection on a portrait picture", () => {
		expect(cropToNatural({ unit: "%", x: 0, y: 25, width: 100, height: 50 }, { width: 100, height: 200 })).toEqual({
			x: 0,
			y: 50,
			size: 100,
		});
	});

	/**
	 * The reason this goes through `clampCrop` rather than converting directly. A percentage of a
	 * pixel count is fractional far more often than not, and the server refuses fractions outright —
	 * so the conversion has to land on whole pixels that still fit, not merely on whole pixels.
	 */
	it("lands on whole pixels that still fit, from percentages that do not divide evenly", () => {
		const natural = { width: 1023, height: 767 };
		const crop = cropToNatural({ unit: "%", x: 33.33, y: 12.5, width: 66.67, height: 88.9 }, natural);

		expect(crop).not.toBeNull();
		const { x, y, size } = crop as CropperValue;
		expect(Number.isInteger(x)).toBe(true);
		expect(Number.isInteger(y)).toBe(true);
		expect(Number.isInteger(size)).toBe(true);
		expect(x + size).toBeLessThanOrEqual(natural.width);
		expect(y + size).toBeLessThanOrEqual(natural.height);
	});

	it("reports nothing usable rather than guessing", () => {
		const natural = { width: 100, height: 100 };
		expect(cropToNatural(undefined, natural)).toBeNull();
		expect(cropToNatural({ unit: "%", x: 0, y: 0, width: 0, height: 0 }, natural)).toBeNull();
		// A pixel crop would be a selection in *rendered* units; converting it as if it were a
		// percentage would be silently wrong, so it is refused instead.
		expect(cropToNatural({ unit: "px", x: 0, y: 0, width: 50, height: 50 }, natural)).toBeNull();
	});
});
