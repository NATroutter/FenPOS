import type { Align } from "@/lib/domain/enums";
import { LINE_HEIGHT_DOTS } from "@/lib/markup/blocks";
import type { ChartData, Series } from "@/lib/markup/document";
import { PLAIN, type SpanStyle } from "@/lib/markup/model";
import type { Canvas, Pattern } from "@/lib/raster/canvas";
import type { LayoutContext } from "@/lib/raster/layout";
import { layoutText, paintRows, type TextRow } from "@/lib/raster/text";

/**
 * The paper a chart spends before it plots anything.
 *
 * **A chart is a frame first and a drawing second.** Where the bars stand, where a line's points
 * fall and how wide a pie is drawn all follow from one rectangle — the plot — and that rectangle is
 * what is left of the chart once its title, its axis labels and its legend have taken their dots.
 * Settling the frame on its own is what lets the four chart bodies each draw into a rectangle they
 * did not have to work out for themselves, and what lets them agree with each other about where
 * that rectangle is.
 *
 * Everything here is in the chart's own coordinates, with (0, 0) at its top-left corner, so a frame
 * is worked out once for a width and stays true wherever on the paper the chart is finally drawn.
 */

/** Dots between the title and what it titles. */
const TITLE_GAP_DOTS = 4;

/** Dots between an axis' labels and the plot they measure. */
const AXIS_GAP_DOTS = 4;

/** A legend swatch is square, and sized to read as a sample of a fill rather than as a mark. */
const SWATCH_DOTS = 12;

/** Dots between a legend's swatch and the name beside it. */
const SWATCH_GAP_DOTS = 4;

/** Dots between the plot and a legend, whichever side of it the legend ends up on. */
const LEGEND_GAP_DOTS = 8;

/** Dots between one legend entry and the next. */
const ENTRY_GAP_DOTS = 2;

/**
 * The narrowest plot worth drawing beside a legend.
 *
 * A plot narrower than this stops being a chart and becomes a column of smudges: on 58mm paper a
 * bar chart has about 380 dots to divide between its categories, and taking a legend's width out of
 * the side of that leaves too little for the bars themselves.
 */
const MIN_PLOT_WIDTH_DOTS = 200;

/** Round values an axis is marked at. Five asked for, four to six drawn, depending on the range. */
const TICK_COUNT = 5;

/** The title's face: the larger of the two built-in fonts, since it names the whole chart. */
const TITLE_STYLE: SpanStyle = { ...PLAIN, font: "A" };

/** Everything else's face: the smaller built-in font, so labels stay out of the drawing's way. */
const LABEL_STYLE: SpanStyle = { ...PLAIN, font: "B" };

/** The fills a pie's slices take, since one series' single pattern cannot tell them apart. */
const SLICE_PATTERNS: readonly Series["pattern"][] = ["solid", "hatch", "dot", "hollow"];

/** What a chart's parts are given of the width and height it occupies. */
export interface ChartFrame {
	plot: { x: number; y: number; width: number; height: number };
	legend: { x: number; y: number; width: number; height: number } | null;
	titleHeight: number;
}

/** One line of a legend: a fill, and the name printed beside it. */
interface LegendEntry {
	label: string;
	pattern: Series["pattern"];
}

/**
 * The dots a chart occupies.
 *
 * Counted in printed lines rather than in dots, because a chart shares a receipt with text and an
 * author sizing one is deciding how much of the receipt it takes rather than how many dots high it
 * is.
 *
 * @param chart the chart
 * @returns its height in dots
 */
export function chartHeight(chart: ChartData): number {
	return chart.height * LINE_HEIGHT_DOTS;
}

/**
 * Divides a chart's dots between its title, its axes, its legend and the plot itself.
 *
 * The legend goes beside the plot when there is room and underneath it when there is not, and which
 * of the two happens is decided against the widest a legend may grow — half the chart — rather than
 * against the width these particular names happen to need. A chart that rearranged itself because a
 * series was renamed would be a chart whose shape the author cannot predict.
 *
 * @param chart what is being plotted
 * @param width the dots the chart has across
 * @param context the fonts the labels are set in
 * @returns where each part of the chart goes, in the chart's own coordinates
 */
export function chartFrame(chart: ChartData, width: number, context: LayoutContext): ChartFrame {
	const labelHeight = context.typeface(LABEL_STYLE).cellHeight;
	const titleHeight = chart.title === null ? 0 : context.typeface(TITLE_STYLE).cellHeight + TITLE_GAP_DOTS;

	// A pie has no axes to label: its slices are measured against each other rather than against a
	// scale, which is why its legend is drawn whether or not the author asked for one.
	const axisWidth = chart.type === "pie" ? 0 : widest(tickLabels(chart), context) + AXIS_GAP_DOTS;
	const axisHeight = chart.type === "pie" ? 0 : labelHeight + AXIS_GAP_DOTS;

	const entries = legendEntries(chart);
	const entryHeight = Math.max(SWATCH_DOTS, labelHeight) + ENTRY_GAP_DOTS;
	const legendWidth = entries.length === 0 ? 0 : SWATCH_DOTS + SWATCH_GAP_DOTS + widest(labelsOf(entries), context);
	const legendHeight = entries.length * entryHeight;
	const beside =
		entries.length > 0 && width - axisWidth - LEGEND_GAP_DOTS - Math.floor(width / 2) >= MIN_PLOT_WIDTH_DOTS;

	const below = entries.length > 0 && !beside;
	const plot = {
		x: axisWidth,
		y: titleHeight,
		width: Math.max(0, width - axisWidth - (beside ? legendWidth + LEGEND_GAP_DOTS : 0)),
		height: Math.max(0, chartHeight(chart) - titleHeight - axisHeight - (below ? legendHeight : 0)),
	};

	if (entries.length === 0) {
		return { plot, legend: null, titleHeight };
	}
	const legend = beside
		? { x: plot.x + plot.width + LEGEND_GAP_DOTS, y: plot.y, width: legendWidth, height: legendHeight }
		: { x: plot.x, y: plot.y + plot.height + axisHeight, width: legendWidth, height: legendHeight };
	return { plot, legend, titleHeight };
}

/**
 * The round values an axis is marked at.
 *
 * Round rather than evenly divided, because an axis is read rather than measured: marks at 0, 20,
 * 40 tell a reader what a bar is worth at a glance, where marks at 0, 18.75, 37.5 leave them doing
 * arithmetic. The step is the first of 1, 2 or 5 times a power of ten that is coarse enough to span
 * the range in the marks asked for, and the range is then widened outwards to land on it.
 *
 * @param min the lowest value that must be covered
 * @param max the highest value that must be covered
 * @param count how many marks to aim for; one or two more or fewer may come back
 * @returns the marks, in order, from the lowest to the highest
 */
export function ticks(min: number, max: number, count: number): number[] {
	const raw = (max - min) / Math.max(1, count - 1);
	if (!(raw > 0)) {
		// Nothing but zeroes, or a single repeated value: there is no range to divide, so the axis is
		// given a unit of its own rather than a step of zero that no loop would ever leave.
		return [min, min + 1];
	}

	const magnitude = 10 ** Math.floor(Math.log10(raw));
	const step =
		[1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? magnitude * 10;
	const from = Math.floor(min / step) * step;
	const steps = Math.round((Math.ceil(max / step) * step - from) / step);

	// Each mark is counted from the first rather than added to the one before it: a step of 0.1 added
	// up eleven times is 1.0999999999999999, and an axis labelled that way is a bug a reader can see.
	return Array.from({ length: steps + 1 }, (_, index) => round(from + index * step));
}

/**
 * Draws a chart's frame: its title, its axes and its legend.
 *
 * @param canvas the paper
 * @param chart what is being plotted
 * @param x the chart's left edge
 * @param y the chart's top edge
 * @param width the dots the chart has across
 * @param context the fonts the labels are set in
 */
export function paintChart(
	canvas: Canvas,
	chart: ChartData,
	x: number,
	y: number,
	width: number,
	context: LayoutContext,
): void {
	const frame = chartFrame(chart, width, context);

	if (chart.title !== null) {
		paintRows(canvas, rowsOf(chart.title, TITLE_STYLE, width, "CENTER", context), x, y);
	}
	if (chart.type !== "pie") {
		paintAxes(canvas, chart, frame, x, y, context);
	}
	if (frame.legend) {
		paintLegend(canvas, legendEntries(chart), frame.legend, x, y, context);
	}
}

/**
 * Draws the two axes, their marks and the categories under them.
 *
 * The horizontal axis is drawn at zero rather than at the foot of the plot, which are the same line
 * until a value is negative and the plot has to hold the marks below it.
 */
function paintAxes(
	canvas: Canvas,
	chart: ChartData,
	frame: ChartFrame,
	x: number,
	y: number,
	context: LayoutContext,
): void {
	const { plot } = frame;
	const marks = chartTicks(chart);
	const at = scale(marks, plot.y, plot.height);

	// Clamped into the marks rather than taken as zero outright: an axis whose marks are all one side
	// of zero has no row for it, and the line belongs at the end of the scale nearest to it.
	const zero = Math.min(Math.max(0, marks[0]), marks[marks.length - 1]);
	canvas.vLine(x + plot.x, y + plot.y, plot.height);
	canvas.hLine(x + plot.x, y + at(zero), plot.width);

	const gutter = Math.max(0, plot.x - AXIS_GAP_DOTS);
	const labelHeight = context.typeface(LABEL_STYLE).cellHeight;
	for (const mark of marks) {
		const rows = rowsOf(format(mark), LABEL_STYLE, gutter, "RIGHT", context);
		paintRows(canvas, rows, x, y + at(mark) - Math.floor(labelHeight / 2));
	}

	// The categories divide the plot between them and each is centred in its own share, which is
	// where a bar chart's bars stand and where a line chart's points fall.
	const slot = chart.labels.length === 0 ? 0 : plot.width / chart.labels.length;
	for (const [index, label] of chart.labels.entries()) {
		const rows = rowsOf(label, LABEL_STYLE, Math.floor(slot), "CENTER", context);
		paintRows(canvas, rows, x + plot.x + Math.floor(index * slot), y + plot.y + plot.height + AXIS_GAP_DOTS);
	}
}

/** Draws one line per entry: the fill it is drawn with, and the name it goes by. */
function paintLegend(
	canvas: Canvas,
	entries: LegendEntry[],
	box: NonNullable<ChartFrame["legend"]>,
	x: number,
	y: number,
	context: LayoutContext,
): void {
	const labelHeight = context.typeface(LABEL_STYLE).cellHeight;
	const entryHeight = Math.max(SWATCH_DOTS, labelHeight) + ENTRY_GAP_DOTS;

	for (const [index, entry] of entries.entries()) {
		const top = y + box.y + index * entryHeight;
		paintSwatch(canvas, entry.pattern, x + box.x, top + Math.floor((entryHeight - SWATCH_DOTS) / 2));
		const width = Math.max(0, box.width - SWATCH_DOTS - SWATCH_GAP_DOTS);
		paintRows(
			canvas,
			rowsOf(entry.label, LABEL_STYLE, width, "LEFT", context),
			x + box.x + SWATCH_DOTS + SWATCH_GAP_DOTS,
			top + Math.floor((entryHeight - labelHeight) / 2),
		);
	}
}

/** A sample of one fill: `hollow` is the outline the fills are all drawn inside. */
function paintSwatch(canvas: Canvas, pattern: Series["pattern"], x: number, y: number): void {
	if (pattern === "hollow") {
		canvas.rect(x, y, SWATCH_DOTS, SWATCH_DOTS, 1);
		return;
	}
	canvas.fill(x, y, SWATCH_DOTS, SWATCH_DOTS, pattern as Pattern);
}

/**
 * What a chart's legend lists.
 *
 * A pie is the exception: its one series is the whole, so what the legend names is the slices — the
 * chart's own labels — rather than the series they came from.
 */
function legendEntries(chart: ChartData): LegendEntry[] {
	if (!showsLegend(chart)) {
		return [];
	}
	if (chart.type === "pie") {
		return chart.series[0].values.map((_, index) => ({
			label: chart.labels[index] ?? String(index + 1),
			pattern: SLICE_PATTERNS[index % SLICE_PATTERNS.length],
		}));
	}
	return chart.series.map((series, index) => ({
		label: series.label ?? String(index + 1),
		pattern: series.pattern,
	}));
}

/**
 * Whether a legend is drawn at all.
 *
 * One series named once in its own title needs no key, which is what `auto` means; a pie always
 * does, because nothing else on it says which slice is which.
 */
function showsLegend(chart: ChartData): boolean {
	if (chart.legend === "off") {
		return false;
	}
	return chart.legend === "on" || chart.series.length > 1 || chart.type === "pie";
}

/** The marks this chart's value axis carries. */
function chartTicks(chart: ChartData): number[] {
	const values = chart.series.flatMap((series) => series.values);
	// From zero unless something is negative: a bar drawn from a floor of its own smallest value is a
	// bar whose length says nothing about what it is worth.
	return ticks(Math.min(0, ...values), Math.max(0, ...values), TICK_COUNT);
}

/** This chart's marks as they are printed. */
function tickLabels(chart: ChartData): string[] {
	return chartTicks(chart).map(format);
}

/** Where a value sits down the plot, with the lowest mark at its foot and the highest at its head. */
function scale(marks: number[], top: number, height: number): (value: number) => number {
	const low = marks[0];
	const high = marks[marks.length - 1];
	const span = high - low || 1;
	return (value) => top + height - Math.round(((value - low) / span) * height);
}

/** A mark as it is printed: the noise binary fractions leave behind is not part of the number. */
function format(value: number): string {
	return String(round(value));
}

function round(value: number): number {
	return Number(value.toPrecision(12));
}

function labelsOf(entries: LegendEntry[]): string[] {
	return entries.map((entry) => entry.label);
}

/** The dots the longest of these strings occupies, set in the label face. */
function widest(texts: string[], context: LayoutContext): number {
	return texts.reduce(
		(dots, text) => Math.max(dots, rowWidth(rowsOf(text, LABEL_STYLE, Number.MAX_SAFE_INTEGER, "LEFT", context))),
		0,
	);
}

function rowsOf(text: string, style: SpanStyle, width: number, align: Align, context: LayoutContext): TextRow[] {
	return layoutText([{ kind: "run", text, style, column: 1 }], width, false, align, context);
}

function rowWidth(rows: TextRow[]): number {
	return rows.reduce((widest, row) => Math.max(widest, row.width), 0);
}
