import { describe, expect, it } from "vitest";
import type { BlockNode, ChartData } from "@/lib/markup/document";
import { parseDocument } from "@/lib/markup/parser";
import { chartFrame, chartHeight, ticks } from "@/lib/raster/charts";
import { renderRasterLine } from "@/lib/raster/layout";
import { context } from "../../helpers/layout-context";
import { ascii, expectRasterToMatchGolden } from "../../helpers/pbm";

const chartOf = (source: string): ChartData => (parseDocument(source).nodes[0] as BlockNode).chart as ChartData;

describe("ticks", () => {
	it("picks round steps spanning the range from zero", () => {
		expect(ticks(0, 75, 5)).toEqual([0, 20, 40, 60, 80]);
		expect(ticks(0, 7, 5)).toEqual([0, 2, 4, 6, 8]);
		expect(ticks(-3, 9, 5)).toEqual([-5, 0, 5, 10]);
	});
});

describe("chartFrame", () => {
	it("reserves the title and axes and puts a legend to the right when the plot stays wide", () => {
		const frame = chartFrame(
			chartOf('<chart=bar height=10 title="Sales">\n<series=A>1,2</series>\n<series=B>2,3</series>\n</chart>'),
			576,
			context,
		);

		expect(frame.titleHeight).toBe(28);
		expect(frame.legend).not.toBeNull();
		expect(frame.legend?.x).toBeGreaterThan(frame.plot.x + frame.plot.width);
		expect(frame.plot.width).toBeGreaterThanOrEqual(200);
	});

	it("drops the legend below on narrow paper", () => {
		const frame = chartFrame(
			chartOf("<chart=bar height=10>\n<series=A>1</series>\n<series=B>2</series>\n</chart>"),
			384,
			context,
		);

		expect(frame.legend?.y).toBeGreaterThan(frame.plot.y + frame.plot.height);
	});

	it("has no legend for one series under auto", () => {
		expect(chartFrame(chartOf("<chart=bar>\n<series>1</series>\n</chart>"), 384, context).legend).toBeNull();
	});
});

describe("bar and line charts", () => {
	it("draws grouped bars", () => {
		expectRasterToMatchGolden(
			renderRasterLine(
				parseDocument(
					'<chart=bar height=8 title="Sales by hour">\n<series=A>3,5,2</series>\n<series=B>4,1,6</series>\n<labels>08,09,10</labels>\n</chart>',
				).nodes,
				context,
			),
			"chart-bar",
		);
	});

	it("draws a line with markers and an area", () => {
		expectRasterToMatchGolden(
			renderRasterLine(
				parseDocument(
					'<chart=line height=10 title="Temperature" area=on>\n<series=Temp pattern=hatch marker=circle>62,64,68,72,74,75</series>\n<labels>08,09,10,11,12,13</labels>\n</chart>',
				).nodes,
				context,
			),
			"chart-line-area",
		);
	});

	it("starts the axis below zero when a value is negative", () => {
		const raster = renderRasterLine(
			parseDocument("<chart=line height=6>\n<series>-2,1,3</series>\n</chart>").nodes,
			context,
		);

		expect(raster.heightDots).toBe(6 * 24);
	});
});

describe("pie and scatter charts", () => {
	it("draws a pie with a legend", () => {
		expectRasterToMatchGolden(
			renderRasterLine(
				parseDocument(
					'<chart=pie height=10 title="Share">\n<series>50,30,20</series>\n<labels>Coffee,Tea,Water</labels>\n</chart>',
				).nodes,
				context,
			),
			"chart-pie",
		);
	});

	/**
	 * A pie as deep as a series may be, drawn inside a request's patience.
	 *
	 * The number is not a benchmark so much as a floor with a great deal of air under it: the same
	 * drawing costs a few tens of milliseconds when the circle is walked once, and seconds when it is
	 * walked once per slice. A preview paints the same document twice, so anything that blocks here
	 * blocks twice over.
	 */
	it("draws a pie of as many slices as a series may hold without stalling", () => {
		const values = Array.from({ length: 2000 }, (_, index) => (index % 7) + 1).join(",");
		const nodes = parseDocument(`<chart=pie height=40 legend=off>\n<series>${values}</series>\n</chart>`).nodes;

		const started = performance.now();
		const raster = renderRasterLine(nodes, context);
		const elapsed = performance.now() - started;

		// An empty raster would render instantly and prove nothing, so the ink is asserted too.
		expect(ascii(raster)).toContain("#");
		expect(elapsed).toBeLessThan(500);
	});

	it("stops a pie's legend where the chart ends rather than listing every slice", () => {
		const values = Array.from({ length: 2000 }, () => 1).join(",");
		const chart = chartOf(`<chart=pie height=10>\n<series>${values}</series>\n</chart>`);

		expect(chart.series[0].values).toHaveLength(2000);
		expect(chartFrame(chart, 384, context).legend?.height).toBeLessThanOrEqual(chartHeight(chart));
	});

	it("draws scatter points with cycling markers", () => {
		expectRasterToMatchGolden(
			renderRasterLine(
				parseDocument("<chart=scatter height=8>\n<series=A>1:2,2:3,3:5</series>\n<series=B>1:4,2:1</series>\n</chart>")
					.nodes,
				context,
			),
			"chart-scatter",
		);
	});
});
