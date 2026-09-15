import { describe, expect, it } from "vitest";
import type { BlockNode, ChartData } from "@/lib/markup/document";
import { parseDocument } from "@/lib/markup/parser";
import { chartFrame, ticks } from "@/lib/raster/charts";
import { context } from "../../helpers/layout-context";

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
