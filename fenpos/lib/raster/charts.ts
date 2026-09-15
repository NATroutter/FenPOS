import type { Align } from "@/lib/domain/enums";
import { LINE_HEIGHT_DOTS } from "@/lib/markup/blocks";
import type { ChartData, Series } from "@/lib/markup/document";
import { PLAIN, type SpanStyle } from "@/lib/markup/model";
import { type Canvas, type Pattern, patternDot } from "@/lib/raster/canvas";
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

/** Dots a mark reaches outside the axis it measures, where it cannot be mistaken for the plot. */
const TICK_DOTS = 3;

/** Dots kept clear at each end of a category, so the bars of neighbouring ones never touch. */
const CATEGORY_MARGIN_DOTS = 4;

/** Dots between one series' bar and the next inside the same category. */
const BAR_GAP_DOTS = 2;

/** How far across a marker is drawn. Odd, so it has a middle dot to sit its point on. */
const MARKER_DOTS = 7;

/** What is put after a label too long for the room under its category. */
const ELLIPSIS = "…";

/** The title's face: the larger of the two built-in fonts, since it names the whole chart. */
const TITLE_STYLE: SpanStyle = { ...PLAIN, font: "A" };

/** Everything else's face: the smaller built-in font, so labels stay out of the drawing's way. */
const LABEL_STYLE: SpanStyle = { ...PLAIN, font: "B" };

/**
 * The fills a pie's slices take, since one series' single pattern cannot tell them apart.
 *
 * Every one of them inks something, unlike the fills a series may ask for: `hollow` says to draw a
 * shape's outline instead of its inside, and a slice already has its edges and the rim drawn for it,
 * so a hollow slice would be a slice that is simply not there.
 */
const SLICE_PATTERNS: readonly Pattern[] = ["solid", "hatch", "dot", "light", "dark"];

/** Dots between the plot's nearest edge and the pie in it, so the rim is not drawn against it. */
const PIE_MARGIN_DOTS = 2;

/** A whole turn, which is what a pie divides up. */
const TURN = 2 * Math.PI;

/** What a shape is drawn with: what a series asked for, or one of the fills a pie's slices take. */
type Fill = Series["pattern"] | Pattern;

/** What a chart's parts are given of the width and height it occupies. */
export interface ChartFrame {
	plot: { x: number; y: number; width: number; height: number };
	legend: { x: number; y: number; width: number; height: number } | null;
	titleHeight: number;
}

/** One line of a legend: a fill, and the name printed beside it. */
interface LegendEntry {
	label: string;
	pattern: Fill;
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
		paintAxes(canvas, chart, frame, x, y, width, context);
	}
	if (chart.type === "bar") {
		paintBars(canvas, chart, frame, x, y);
	}
	if (chart.type === "line") {
		paintLines(canvas, chart, frame, x, y);
	}
	if (chart.type === "pie") {
		paintPie(canvas, chart, frame, x, y);
	}
	if (chart.type === "scatter") {
		paintScatter(canvas, chart, frame, x, y);
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
	width: number,
	context: LayoutContext,
): void {
	const { plot } = frame;
	const marks = chartTicks(chart);
	const at = scale(marks, plot.y, plot.height);

	canvas.vLine(x + plot.x, y + plot.y, plot.height);
	canvas.hLine(x + plot.x, y + at(zeroOf(chart)), plot.width);

	const gutter = Math.max(0, plot.x - AXIS_GAP_DOTS);
	const under = y + plot.y + plot.height + AXIS_GAP_DOTS;
	const labelHeight = context.typeface(LABEL_STYLE).cellHeight;
	for (const mark of marks) {
		canvas.hLine(x + plot.x - TICK_DOTS, y + at(mark), TICK_DOTS);
		const rows = rowsOf(format(mark), LABEL_STYLE, gutter, "RIGHT", context);
		paintRows(canvas, rows, x, y + at(mark) - Math.floor(labelHeight / 2));
	}

	if (chart.type === "scatter") {
		// A scatter's horizontal axis measures rather than names: its points carry an x of their own
		// instead of falling into categories, so it is marked the way the value axis is. Labels name
		// categories, and a scatter carrying any is refused long before it reaches the paper.
		const columns = acrossTicks(chart);
		const across = acrossScale(columns, plot.x, plot.width);
		for (const mark of columns) {
			const column = across(mark);
			canvas.vLine(x + column, y + plot.y + plot.height, TICK_DOTS);
			paintUnder(canvas, format(mark), column, x, under, width, context);
		}
		return;
	}

	const slot = chart.labels.length === 0 ? 0 : Math.floor(plot.width / chart.labels.length);
	for (const [index, label] of chart.labels.entries()) {
		paintUnder(canvas, elide(label, slot, context), labelCentre(chart, plot, index), x, under, width, context, slot);
	}
}

/** Writes one name or number under the plot, centred on the dot of the axis it belongs to. */
function paintUnder(
	canvas: Canvas,
	text: string,
	centre: number,
	x: number,
	top: number,
	width: number,
	context: LayoutContext,
	room = width,
): void {
	const rows = rowsOf(text, LABEL_STYLE, room, "LEFT", context);
	const drawn = rowWidth(rows);
	// Held inside the chart rather than centred come what may: the last point of a line sits on the
	// plot's last dot, and a label centred under it would run half of itself off the paper.
	const left = Math.max(0, Math.min(centre - Math.floor(drawn / 2), width - drawn));
	paintRows(canvas, rows, x + left, top);
}

/**
 * The dot one category's label is written under.
 *
 * A bar stands inside its share of the plot and a line's point falls on the boundary between two
 * shares, so a label that belongs under a bar and a label that belongs under a point are half a
 * share apart. Reading the same labels under both would put a line chart's hours between its points.
 */
function labelCentre(chart: ChartData, plot: ChartFrame["plot"], index: number): number {
	if (chart.type === "bar") {
		return plot.x + Math.floor(((index + 0.5) * plot.width) / chart.labels.length);
	}
	return pointX(plot, index, chart.labels.length);
}

/**
 * Draws one bar per series in each category, side by side.
 *
 * The categories come from the longest series rather than from the labels, so a series that carries
 * more numbers than the author labelled is still drawn in full: a chart that quietly dropped values
 * would be worse than one whose last few bars go unnamed.
 */
function paintBars(canvas: Canvas, chart: ChartData, frame: ChartFrame, x: number, y: number): void {
	const { plot } = frame;
	const categories = Math.max(0, ...chart.series.map((series) => series.values.length));
	if (categories === 0 || plot.width <= 0 || chart.series.length === 0) {
		return;
	}

	const at = scale(chartTicks(chart), plot.y, plot.height);
	const base = at(zeroOf(chart));
	const slot = plot.width / categories;
	const room = Math.floor(slot) - 2 * CATEGORY_MARGIN_DOTS - BAR_GAP_DOTS * (chart.series.length - 1);
	const barWidth = Math.floor(room / chart.series.length);
	if (barWidth < 1) {
		// More bars than dots to draw them with: a column of single-dot smudges says less about the
		// numbers than an empty plot does, and the axis still carries the scale.
		return;
	}

	for (let category = 0; category < categories; category++) {
		const left = plot.x + Math.floor(category * slot) + CATEGORY_MARGIN_DOTS;
		for (const [order, series] of chart.series.entries()) {
			const value = series.values[category];
			if (value === undefined) {
				continue;
			}
			const top = at(value);
			paintFilled(
				canvas,
				series.pattern,
				x + left + order * (barWidth + BAR_GAP_DOTS),
				y + Math.min(top, base),
				barWidth,
				Math.abs(base - top),
			);
		}
	}
}

/** Draws each series as a run of straight segments, with its markers and, when asked, its area. */
function paintLines(canvas: Canvas, chart: ChartData, frame: ChartFrame, x: number, y: number): void {
	const { plot } = frame;
	if (plot.width <= 0) {
		return;
	}

	const at = scale(chartTicks(chart), plot.y, plot.height);
	const base = at(zeroOf(chart));
	for (const series of chart.series) {
		const points = series.values.map((value, index) => ({
			x: pointX(plot, index, series.values.length),
			y: at(value),
		}));
		if (points.length === 0) {
			continue;
		}

		if (chart.area) {
			paintArea(canvas, points, series.pattern, base, x, y);
		}
		for (let index = 1; index < points.length; index++) {
			const from = points[index - 1];
			const to = points[index];
			canvas.line(x + from.x, y + from.y, x + to.x, y + to.y);
		}
		for (const point of points) {
			paintMarker(canvas, series.marker, x + point.x, y + point.y);
		}
	}
}

/**
 * Where the point for one of a series' values sits across the plot.
 *
 * The last point lands on the plot's last dot rather than one past its right edge, so a marker at
 * the end of a full-width chart is drawn whole instead of being clipped in half by the paper.
 */
function pointX(plot: ChartFrame["plot"], index: number, count: number): number {
	if (count < 2) {
		return plot.x;
	}
	return plot.x + Math.round((index * (plot.width - 1)) / (count - 1));
}

/**
 * Draws the one series of a pie as slices of a circle.
 *
 * The circle is as wide as the plot's shorter side allows rather than as wide as the paper: a pie
 * says what it has to say with angles, and an ellipse stretched to fill a landscape plot would tell
 * the reader a lie about every one of them.
 */
function paintPie(canvas: Canvas, chart: ChartData, frame: ChartFrame, x: number, y: number): void {
	const { plot } = frame;
	const values = chart.series[0].values;
	const total = values.reduce((sum, value) => sum + value, 0);
	const radius = Math.floor(Math.min(plot.width, plot.height) / 2) - PIE_MARGIN_DOTS;
	if (radius < 1 || total <= 0) {
		return;
	}

	const centreX = x + plot.x + Math.floor(plot.width / 2);
	const centreY = y + plot.y + Math.floor(plot.height / 2);

	let from = 0;
	for (const [index, value] of values.entries()) {
		// The last slice is closed on the turn itself rather than on the sum of the shares before it,
		// which thirds and sevenths leave a fraction of a dot short of a whole circle.
		const to = index === values.length - 1 ? TURN : from + (value / total) * TURN;
		paintSlice(canvas, SLICE_PATTERNS[index % SLICE_PATTERNS.length], centreX, centreY, radius, from, to);
		const edge = rim(radius, from);
		canvas.line(centreX, centreY, centreX + edge.dx, centreY + edge.dy);
		from = to;
	}

	// Every dot whose distance from the centre rounds to the radius, which draws a rounder rim on a
	// grid this coarse than stepping around the circle by angle does.
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dx = -radius; dx <= radius; dx++) {
			if (Math.round(Math.hypot(dx, dy)) === radius) canvas.set(centreX + dx, centreY + dy);
		}
	}
}

/**
 * Inks the dots of one slice.
 *
 * Dot by dot over the square the circle sits in, rather than by tracing the slice's outline and
 * filling what it encloses: a slice is defined by two questions a dot can answer on its own — is it
 * within the radius, and does it lie between the two angles — and asking them of every dot needs
 * neither an outline nor a scanline order.
 */
function paintSlice(
	canvas: Canvas,
	pattern: Pattern,
	centreX: number,
	centreY: number,
	radius: number,
	from: number,
	to: number,
): void {
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dx = -radius; dx <= radius; dx++) {
			if (Math.hypot(dx, dy) > radius) {
				continue;
			}
			const angle = angleOf(dx, dy);
			if (angle < from || angle >= to) {
				continue;
			}
			if (patternDot(pattern, centreX + dx, centreY + dy)) canvas.set(centreX + dx, centreY + dy);
		}
	}
}

/** How far round the turn a dot lies, from straight up and going clockwise, the way a pie is read. */
function angleOf(dx: number, dy: number): number {
	const angle = Math.atan2(dx, -dy);
	return angle < 0 ? angle + TURN : angle;
}

/** The dot on the rim at one angle, as an offset from the centre, with y counted down the paper. */
function rim(radius: number, angle: number): { dx: number; dy: number } {
	return { dx: Math.round(radius * Math.sin(angle)), dy: -Math.round(radius * Math.cos(angle)) };
}

/** Draws each series' points as its own mark, with nothing joining them: a scatter plots pairs. */
function paintScatter(canvas: Canvas, chart: ChartData, frame: ChartFrame, x: number, y: number): void {
	const { plot } = frame;
	if (plot.width <= 0) {
		return;
	}

	const across = acrossScale(acrossTicks(chart), plot.x, plot.width);
	const at = scale(chartTicks(chart), plot.y, plot.height);
	for (const series of chart.series) {
		for (const [valueX, valueY] of series.points ?? []) {
			paintMarker(canvas, series.marker, x + across(valueX), y + at(valueY));
		}
	}
}

/**
 * Fills the ground between a line and the value axis' zero.
 *
 * Column by column rather than as one shape: the region under a run of segments is not a rectangle
 * and has no outline worth tracing, but every column of it is a single run of dots from the zero
 * line to wherever the line passes over that column.
 */
function paintArea(
	canvas: Canvas,
	points: { x: number; y: number }[],
	pattern: Series["pattern"],
	base: number,
	x: number,
	y: number,
): void {
	if (pattern === "hollow") {
		return;
	}

	for (let index = 1; index < points.length; index++) {
		const from = points[index - 1];
		const to = points[index];
		for (let column = from.x; column <= to.x; column++) {
			const along = to.x === from.x ? 0 : (column - from.x) / (to.x - from.x);
			const top = Math.round(from.y + along * (to.y - from.y));
			canvas.fill(x + column, y + Math.min(top, base), 1, Math.abs(base - top), pattern as Pattern);
		}
	}
}

/** Draws the mark a series puts on each of its points, centred on the point itself. */
function paintMarker(canvas: Canvas, marker: Series["marker"], x: number, y: number): void {
	const reach = Math.floor(MARKER_DOTS / 2);
	switch (marker) {
		case "none":
			return;
		case "square":
			canvas.rect(x - reach, y - reach, MARKER_DOTS, MARKER_DOTS);
			return;
		case "triangle":
			canvas.line(x, y - reach, x - reach, y + reach);
			canvas.line(x - reach, y + reach, x + reach, y + reach);
			canvas.line(x + reach, y + reach, x, y - reach);
			return;
		case "cross":
			canvas.line(x - reach, y - reach, x + reach, y + reach);
			canvas.line(x - reach, y + reach, x + reach, y - reach);
			return;
		case "circle":
			// Every dot whose distance from the middle rounds to the marker's radius, which on a grid
			// this small draws a rounder ring than stepping around the circle does.
			for (let dy = -reach; dy <= reach; dy++) {
				for (let dx = -reach; dx <= reach; dx++) {
					if (Math.round(Math.hypot(dx, dy)) === reach) canvas.set(x + dx, y + dy);
				}
			}
			return;
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
		paintFilled(
			canvas,
			entry.pattern,
			x + box.x,
			top + Math.floor((entryHeight - SWATCH_DOTS) / 2),
			SWATCH_DOTS,
			SWATCH_DOTS,
		);
		const width = Math.max(0, box.width - SWATCH_DOTS - SWATCH_GAP_DOTS);
		paintRows(
			canvas,
			rowsOf(entry.label, LABEL_STYLE, width, "LEFT", context),
			x + box.x + SWATCH_DOTS + SWATCH_GAP_DOTS,
			top + Math.floor((entryHeight - labelHeight) / 2),
		);
	}
}

/** A rectangle a series claims: its pattern laid inside it, or the outline `hollow` draws instead. */
function paintFilled(canvas: Canvas, pattern: Fill, x: number, y: number, width: number, height: number): void {
	if (width <= 0 || height <= 0) {
		return;
	}
	if (pattern === "hollow") {
		canvas.rect(x, y, width, height, 1);
		return;
	}
	canvas.fill(x, y, width, height, pattern);
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
			label: chart.labels[index] ?? `#${index + 1}`,
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

/** The marks a scatter's horizontal axis carries, read off the x of every point it plots. */
function acrossTicks(chart: ChartData): number[] {
	const values = chart.series.flatMap((series) => (series.points ?? []).map(([value]) => value));
	return ticks(Math.min(0, ...values), Math.max(0, ...values), TICK_COUNT);
}

/**
 * The value the horizontal axis is drawn at, and the value a bar or an area is measured from.
 *
 * Clamped into the marks rather than taken as zero outright: an axis whose marks are all one side of
 * zero has no row for it, and the line belongs at the end of the scale nearest to it.
 */
function zeroOf(chart: ChartData): number {
	const marks = chartTicks(chart);
	return Math.min(Math.max(0, marks[0]), marks[marks.length - 1]);
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

/**
 * Where a value sits across the plot, with the lowest mark at its left edge and the highest at its
 * right.
 *
 * The last dot of the plot rather than the one past it, where a line chart puts its last point, so
 * that the two kinds of chart put the top of a range in the same place.
 */
function acrossScale(marks: number[], left: number, width: number): (value: number) => number {
	const low = marks[0];
	const high = marks[marks.length - 1];
	const span = high - low || 1;
	return (value) => left + Math.round(((value - low) / span) * Math.max(0, width - 1));
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

/**
 * A label cut down to the room under its category.
 *
 * Cut rather than wrapped or overrun: a second row would push the plot's neighbours around, and a
 * label that ran on would collide with the one beside it, which is worse than a name the reader can
 * see has been shortened.
 */
function elide(text: string, width: number, context: LayoutContext): string {
	if (textWidth(text, context) <= width) {
		return text;
	}

	// No glyph is narrower than a dot, so nothing past the first `width` characters can be kept, and
	// starting the search there bounds it by the room under the category rather than by the label.
	const kept = [...text].slice(0, Math.max(0, width));
	while (kept.length > 0 && textWidth(kept.join("") + ELLIPSIS, context) > width) {
		kept.pop();
	}
	return kept.length === 0 ? "" : kept.join("") + ELLIPSIS;
}

/** The dots the longest of these strings occupies, set in the label face. */
function widest(texts: string[], context: LayoutContext): number {
	return texts.reduce((dots, text) => Math.max(dots, textWidth(text, context)), 0);
}

/** The dots one string occupies, set in the label face and given all the room it asks for. */
function textWidth(text: string, context: LayoutContext): number {
	return rowWidth(rowsOf(text, LABEL_STYLE, Number.MAX_SAFE_INTEGER, "LEFT", context));
}

function rowsOf(text: string, style: SpanStyle, width: number, align: Align, context: LayoutContext): TextRow[] {
	return layoutText([{ kind: "run", text, style, column: 1 }], width, false, align, context);
}

function rowWidth(rows: TextRow[]): number {
	return rows.reduce((widest, row) => Math.max(widest, row.width), 0);
}
