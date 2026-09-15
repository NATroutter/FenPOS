import { describe, expect, it } from "vitest";
import { assetRasterSchema } from "@/lib/link/protocol";
import { parseDocument } from "@/lib/markup/parser";
import { renderRasterLine } from "@/lib/raster/layout";
import { context } from "../../helpers/layout-context";

/**
 * Every kind of drawn line, at three widths, has to come out a rectangle the wire will carry: exactly
 * `columns * 12` dots wide, with packed bytes that account for precisely that many rows. A layout node
 * that painted past its own measured height, or one whose width drifted from what `dotWidth` promised,
 * would still produce *a* raster — this is what catches the picture being the wrong shape rather than
 * merely present.
 */
const SOURCES = [
	"<box>\nA\n</box>",
	"<box border=double>\n<box border=thick>\nA\n</box>\n</box>",
	"<table>\n<row><cell>a</cell><cell>b</cell></row>\n</table>",
	"<bar value=50>",
	"<text font=mono size=100>Wide text that wraps</text>",
	"<align to=right><box width=30>\nx\n</box></align>",
];

describe("every raster", () => {
	it.each(SOURCES)("fills its rectangle: %s", (source) => {
		for (const columns of [32, 42, 48]) {
			const raster = renderRasterLine(parseDocument(source).nodes, { ...context, columns });

			expect(raster.widthDots).toBe(columns * 12);
			expect(
				assetRasterSchema.safeParse({
					name: "x",
					widthDots: raster.widthDots,
					heightDots: raster.heightDots,
					data: raster.packed.toString("base64"),
				}).success,
			).toBe(true);
		}
	});
});
