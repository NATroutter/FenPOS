import { Canvas } from "@/lib/raster/canvas";
import { builtinTypeface, bundledFace, typefaceFor } from "@/lib/raster/fonts";
import type { LayoutContext } from "@/lib/raster/layout";

/**
 * A 40x20 outline, standing in for a resolved image.
 *
 * An outline rather than a solid block so the goldens show where it was placed rather than only
 * that something was: a rectangle that has drifted a dot is visible, a filled one is not.
 */
const stamp = new Canvas(40, 20);
stamp.rect(0, 0, 40, 20, 2);

/** A 32-column (384-dot) layout context, shared by every raster layout test. */
export const context: LayoutContext = {
	columns: 32,
	images: new Map([["icon", { width: 40, height: 20, natural: stamp.pack(), inline: new Map() }]]),
	typeface: (style) => (style.face ? typefaceFor(bundledFace(), style.faceDots) : builtinTypeface(style.font)),
	onUnsupported: "REPLACE",
	codepage: "CP437",
	defaultWrap: true,
	limits: { maxTableCells: 2000, maxSeriesPoints: 2000 },
};
