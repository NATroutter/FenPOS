import { describe, expect, it } from "vitest";
import { parseDocument } from "@/lib/markup/parser";
import { Canvas } from "@/lib/raster/canvas";
import { builtinTypeface, bundledFace, typefaceFor } from "@/lib/raster/fonts";
import { type LayoutContext, renderRasterLine } from "@/lib/raster/layout";
import { expectRasterToMatchGolden } from "../../helpers/pbm";

/**
 * A 40x20 outline, standing in for a resolved image.
 *
 * An outline rather than a solid block so the goldens show where it was placed rather than only
 * that something was: a rectangle that has drifted a dot is visible, a filled one is not.
 */
const stamp = new Canvas(40, 20);
stamp.rect(0, 0, 40, 20, 2);

const context: LayoutContext = {
	columns: 32,
	images: new Map([["icon", { width: 40, height: 20, natural: stamp.pack(), inline: new Map() }]]),
	typeface: (style) => (style.face ? typefaceFor(bundledFace(), style.faceDots) : builtinTypeface(style.font)),
	onUnsupported: "REPLACE",
	codepage: "CP437",
	defaultWrap: true,
	limits: { maxTableCells: 2000, maxSeriesPoints: 2000 },
};

describe("renderRasterLine", () => {
	it("draws a configured-font line the paper's width, one row tall", () => {
		const raster = renderRasterLine(parseDocument("<font=mono size=40>Good morning</font>").nodes, context);

		expect(raster.widthDots).toBe(384);
		expect(raster.heightDots).toBe(typefaceFor(bundledFace(), 40).cellHeight);
		expectRasterToMatchGolden(raster, "font-line");
	});

	it("puts an inline image beside text, centred", () => {
		const raster = renderRasterLine(
			parseDocument("<align=center><image>icon</image> ASTRONOMY</align>").nodes,
			context,
		);

		expect(raster.heightDots).toBe(24);
		expectRasterToMatchGolden(raster, "inline-image");
	});

	/**
	 * A width on the tag still means that share of the paper, even on a line drawn here: only a tag
	 * with no width at all falls back to the image's own size.
	 */
	it("draws an image at the width its tag asked for, rather than at its own", () => {
		const half = new Canvas(192, 96);
		half.rect(0, 0, 192, 96, 2);
		const withHalf: LayoutContext = {
			...context,
			images: new Map([
				["icon", { width: 40, height: 20, natural: stamp.pack(), inline: new Map([[192, half.pack()]]) }],
			]),
		};

		expect(() => renderRasterLine(parseDocument("<image=50>icon</image> x").nodes, context)).toThrow(/resolveImages/);
		expect(renderRasterLine(parseDocument("<image=50>icon</image> x").nodes, withHalf).heightDots).toBe(96);
	});

	it("wraps a long configured-font line", () => {
		const raster = renderRasterLine(
			parseDocument("<font=mono size=30>one two three four five six seven eight nine ten</font>").nodes,
			context,
		);

		expect(raster.heightDots).toBeGreaterThan(typefaceFor(bundledFace(), 30).cellHeight);
	});
});
