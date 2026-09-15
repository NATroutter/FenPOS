import { describe, expect, it } from "vitest";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import { parseDocument } from "@/lib/markup/parser";
import { Canvas } from "@/lib/raster/canvas";
import { bundledFace, typefaceFor } from "@/lib/raster/fonts";
import { type LayoutContext, renderRasterLine } from "@/lib/raster/layout";
import { context } from "../../helpers/layout-context";
import { expectRasterToMatchGolden } from "../../helpers/pbm";

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
		const stamp = new Canvas(40, 20);
		stamp.rect(0, 0, 40, 20, 2);
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

	/**
	 * A regression for align carrying across a block that interrupts a line it owns: the row after
	 * the rule has to keep the align the wrapper set, rather than falling back to the default the
	 * way a fresh sequence would.
	 */
	it("keeps text after a rule centred when an align wraps both", () => {
		const centred = renderRasterLine(parseDocument("<align=center>a</align>").nodes, context);
		const wrapped = renderRasterLine(parseDocument("<align=center>a\n<hr>\na</align>").nodes, context);

		const leftmostInk = (raster: typeof centred, yStart: number, yEnd: number): number => {
			const canvas = new Canvas(raster.widthDots, raster.heightDots);
			canvas.blit(raster, 0, 0);
			for (let x = 0; x < raster.widthDots; x++) {
				for (let y = yStart; y < yEnd; y++) {
					if (canvas.get(x, y)) return x;
				}
			}
			return -1;
		};

		const centredInk = leftmostInk(centred, 0, centred.heightDots);
		const lastRowInk = leftmostInk(wrapped, wrapped.heightDots - 24, wrapped.heightDots);

		expect(centredInk).toBeGreaterThan(0);
		expect(lastRowInk).toBe(centredInk);
	});
});

describe("BoxNode", () => {
	it("frames its content with a single border and half-cell padding", () => {
		const raster = renderRasterLine(parseDocument("<box>\nHello\n</box>").nodes, context);

		expect(raster.widthDots).toBe(384);
		expect(raster.heightDots).toBe(24 + 2 * (1 + 6));
		expectRasterToMatchGolden(raster, "box-single");
	});

	it("draws double and thick borders and honours width and pad", () => {
		expectRasterToMatchGolden(
			renderRasterLine(parseDocument("<box width=50 border=double pad=0>\nA\n</box>").nodes, context),
			"box-double-half",
		);
		expectRasterToMatchGolden(
			renderRasterLine(parseDocument("<box border=thick pad=2>\nA\n</box>").nodes, context),
			"box-thick",
		);
	});

	it("nests a box in a box", () => {
		const raster = renderRasterLine(parseDocument("<box>\n<box border=none>\nA\n</box>\n</box>").nodes, context);

		expect(raster.heightDots).toBe(24 + 2 * 6 + 2 * 7);
	});

	it("centres a narrow box under align", () => {
		const raster = renderRasterLine(parseDocument("<align=center><box width=50>\nA\n</box></align>").nodes, context);
		expectRasterToMatchGolden(raster, "box-centred");
	});

	/**
	 * A blank source line inside a box still holds one line of paper, exactly as it would outside
	 * one — the box's own opening and closing lines are not content lines and hold none.
	 */
	it("gives a blank line inside a box the height of one empty row", () => {
		const tight = renderRasterLine(parseDocument("<box>\nA\nB\n</box>").nodes, context);
		const spaced = renderRasterLine(parseDocument("<box>\nA\n\nB\n</box>").nodes, context);

		expect(spaced.heightDots).toBe(tight.heightDots + 24);
	});
});

/** What a call threw, for assertions about where an error points rather than only that it was one. */
function thrownBy(call: () => unknown): unknown {
	try {
		call();
	} catch (error) {
		return error;
	}
	return null;
}

describe("TableNode", () => {
	it("draws a grid with equal columns", () => {
		const raster = renderRasterLine(
			parseDocument(
				"<table>\n<row><cell>a</cell><cell>b</cell><cell>c</cell></row>\n<row><cell>1</cell><cell>2</cell></row>\n</table>",
			).nodes,
			context,
		);

		expect(raster.heightDots).toBe(2 * (24 + 12) + 3);
		expectRasterToMatchGolden(raster, "table-equal");
	});

	it("sizes columns from the first row and splits the rest", () => {
		expectRasterToMatchGolden(
			renderRasterLine(
				parseDocument("<table>\n<row><cell width=50>wide</cell><cell>a</cell><cell>b</cell></row>\n</table>").nodes,
				context,
			),
			"table-sized",
		);
	});

	it("refuses sized columns over the width", () => {
		const draw = () =>
			renderRasterLine(
				parseDocument("<table>\n<row><cell width=70>a</cell><cell width=40>b</cell></row>\n</table>").nodes,
				context,
			);

		expect(draw).toThrow(MarkupError);
		expect(draw).toThrow(/the sized columns add up to 110%/);
		// The cell that took the table past its own width, so the caller is pointed at the one to shrink.
		expect(thrownBy(draw)).toMatchObject({
			code: MARKUP_ERRORS.invalidAttribute,
			line: 2,
			column: 29,
			detail: "width",
		});
	});

	it("draws a sudoku grid with group rules and shading", () => {
		const row = (cells: string[]) =>
			`<row>${cells.map((cell) => (cell === "." ? "<cell></cell>" : `<cell align=center shade=light>${cell}</cell>`)).join("")}</row>`;
		const rows = Array.from({ length: 9 }, (_, index) =>
			row(Array.from({ length: 9 }, (_, column) => ((index + column) % 3 === 0 ? String(column + 1) : "."))),
		);
		const raster = renderRasterLine(parseDocument(`<table group=3>\n${rows.join("\n")}\n</table>`).nodes, {
			...context,
			columns: 48,
		});

		expectRasterToMatchGolden(raster, "table-sudoku");
	});

	it("inverts a black cell and aligns vertically", () => {
		expectRasterToMatchGolden(
			renderRasterLine(
				parseDocument("<table>\n<row><cell shade=black>on</cell><cell valign=bottom>lo\nlo</cell></row>\n</table>")
					.nodes,
				context,
			),
			"table-shade-valign",
		);
	});
});

describe("GaugeNode", () => {
	it("draws an outlined bar filled to the percentage with the number after it", () => {
		expectRasterToMatchGolden(renderRasterLine(parseDocument("<bar=38 width=80>").nodes, context), "gauge-38");
		expect(renderRasterLine(parseDocument("<bar=0>").nodes, context).heightDots).toBe(24);
	});
});
