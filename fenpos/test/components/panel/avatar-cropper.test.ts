import { describe, expect, it } from "vitest";
import { clampCrop } from "@/components/panel/avatar-cropper";

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
});
