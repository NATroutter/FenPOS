import type { ImageRaster } from "@/lib/assets/dither";
import type { Align } from "@/lib/domain/enums";
import { dotWidth, LINE_HEIGHT_DOTS } from "@/lib/markup/blocks";
import type { BlockNode, BlockTag, ChartData, ImageNode, Node } from "@/lib/markup/document";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import { share } from "@/lib/markup/fill";
import { printedWidthDots, type ResolvedImages } from "@/lib/markup/images";
import { PLAIN, type SpanStyle } from "@/lib/markup/model";
import { Canvas } from "@/lib/raster/canvas";
import { chartHeight, paintChart } from "@/lib/raster/charts";
import { type InlineItem, layoutText, paintRows, type TextContext, type TextRow, textHeight } from "@/lib/raster/text";

/**
 * The line the printer cannot draw, drawn here.
 *
 * **What decides that a line comes through this module is what the device can do, not what the
 * markup says.** A run of the printer's own text is columns the firmware places; a configured face
 * has no command to select it, a block is a region rather than a run, and an image beside text has
 * to be placed against that text. Those three are laid out here instead, in dots, and cross the link
 * as a picture of the line.
 *
 * A layout node measures before it paints, and for the same reason a printed line does: what a row
 * costs has to be known before anything is drawn, because the row above cannot be placed until the
 * row below has said how tall it is. Measuring is also the expensive half — it breaks text into rows
 * — so a node remembers the rows it measured and paints those, rather than laying the same line out
 * twice at the same width.
 */

/** What the layout needs from its surroundings, on top of the fonts the inline flow already asks for. */
export interface LayoutContext extends TextContext {
	/** The device's width in printer columns, which fixes the paper a line is drawn onto. */
	columns: number;
	/** What the pre-pass resolved, so an `<image>` can be placed at the dots it will really occupy. */
	images: ResolvedImages;
	/** The device's setting, used by any inline sequence no `<wrap>` or `<nowrap>` claimed. */
	defaultWrap: boolean;
	limits: { maxTableCells: number; maxSeriesPoints: number };
}

/** The dots something occupies. */
export interface Size {
	width: number;
	height: number;
}

/**
 * One thing that can be measured and then drawn.
 *
 * `availableWidth` is passed to both halves rather than fixed at construction, because a node is
 * measured by whatever encloses it and a box may offer its child less width than the paper has.
 */
export interface LayoutNode {
	measure(availableWidth: number): Size;
	/** Draws the node with its top-left corner at (x, y). Everything clips to the canvas. */
	paint(canvas: Canvas, x: number, y: number, availableWidth: number): void;
}

/** How tall a `<hr>` stands in a drawn line: one printed line, with the rule through its middle. */
const RULE_HEIGHT_DOTS = LINE_HEIGHT_DOTS;

/** A child of a flow, and the align in force when it was placed. */
interface FlowChild {
	node: LayoutNode;
	/** Only meaningful for a block: an inline sequence already bakes its own align into its rows. */
	align: Align;
}

/**
 * Stacks a line's nodes top to bottom.
 *
 * **The grouping is what makes a drawn line look like a printed one.** Consecutive inline nodes —
 * text, fills, scopes, images, and the align and wrap wrappers around them — are one sequence, laid
 * out by `layoutText` exactly as the same characters would have been laid out in columns. A rule, a
 * block or a line break ends the sequence, because none of the three is something that can sit in a
 * row of glyphs, and each becomes a child of its own (a break simply ends one row without adding a
 * child, which is how a block's children — several source lines run together with none of the
 * top-level splitting `renderRasterLine`'s own caller already did — become the several rows of its
 * flow). So `a<hr>b` is three children and `<bold>a</bold> b` is one.
 *
 * The align and wrap in force are threaded down through the walk rather than kept as a variable this
 * closes over, because a wrapper's reach is everything inside it — including a rule or a block that
 * interrupts the sequence — and a variable reset at every such interruption would forget the wrapper
 * the moment anything broke the row it opened on.
 *
 * @param nodes one line's nodes, or — inside a block — every line of its content run together
 * @param context the fonts, the paper and what the pre-pass resolved
 * @param align the justification the flow opens under, for a region that sets one for its content
 * @returns the node that draws them
 */
export function buildFlow(nodes: Node[], context: LayoutContext, align: Align = "LEFT"): LayoutNode {
	const children: FlowChild[] = [];
	let items: InlineItem[] = [];
	// Whether the node just visited was itself a break, tracked across the whole walk rather than per
	// recursive call: it is a question about document order — was the line before this one empty? —
	// and the walk already visits nodes in that order regardless of how deep a scope or an align has
	// nested them. Starts false, which is what keeps a block's own opening line from counting: the
	// first break any block's children carry ends that line, not a blank one before it.
	let previousWasBreak = false;

	const closeSequence = (align: Align, wrap: boolean): void => {
		if (items.length > 0) {
			children.push({ node: inlineSequence(items, align, wrap, context), align: "LEFT" });
			items = [];
		}
	};

	const visit = (list: Node[], style: SpanStyle, align: Align, wrap: boolean): void => {
		for (const node of list) {
			switch (node.kind) {
				case "text":
					previousWasBreak = false;
					items.push({
						kind: "run",
						text: node.text,
						style,
						column: node.column,
						...(node.expandedFrom === undefined ? {} : { expandedFrom: node.expandedFrom }),
					});
					break;
				case "fill":
					previousWasBreak = false;
					items.push({ kind: "fill", character: node.character, style, column: node.column });
					break;
				case "image":
					previousWasBreak = false;
					items.push({ kind: "image", raster: rasterFor(node, context) });
					break;
				case "scope":
					visit(node.children, { ...style, ...node.patch }, align, wrap);
					break;
				case "align":
					// The innermost wrapper wins, which is the same rule a native line follows: the tree
					// allows only one of each per line, so the last one assigned is the only one written.
					// Flushed on the way back out, so trailing text collected under this align is charged
					// to it rather than to whatever align encloses the wrapper itself.
					visit(node.children, style, node.align, wrap);
					closeSequence(node.align, wrap);
					break;
				case "wrap":
					visit(node.children, style, align, node.wrap);
					closeSequence(align, node.wrap);
					break;
				case "rule":
					previousWasBreak = false;
					closeSequence(align, wrap);
					children.push({ node: ruleNode(), align: "LEFT" });
					break;
				case "block":
					previousWasBreak = false;
					closeSequence(align, wrap);
					children.push({ node: blockNode(node, context), align });
					break;
				case "symbol":
				case "void": {
					// Inside a block the tree refuses these outright, which is where that rule belongs: it is
					// about shape. What can still reach here is a line the *device* forced onto this path — a
					// configured face, or an image beside text — where a command the printer would have run
					// for itself has nowhere to go once the line becomes a picture.
					const tag = (node.kind === "void" ? node.directive.kind : node.spec.kind).toLowerCase();
					throw new MarkupError(
						MARKUP_ERRORS.misplacedBlock,
						node.line,
						node.column,
						tag,
						`<${tag}> is printed by the printer and cannot sit on a drawn line`,
					);
				}
				case "break":
					// Only a block's children ever carry one this far: every other caller already split at
					// breaks before handing nodes here. Ending the sequence here is what turns each of a
					// block's source lines into its own row. A break immediately after another one — with
					// nothing placed between them — is a source line with nothing typed on it, which still
					// holds one line of paper the way it would outside a block, so it gets a row of its own.
					if (previousWasBreak) {
						children.push({ node: blankRowNode(context.typeface(style).cellHeight), align: "LEFT" });
					}
					closeSequence(align, wrap);
					previousWasBreak = true;
					break;
			}
		}
	};

	visit(nodes, PLAIN, align, context.defaultWrap);
	closeSequence(align, context.defaultWrap);

	return stack(children);
}

/**
 * Draws one line into the dots that will print it.
 *
 * The canvas is the paper's whole width, whatever the line occupies, because a raster is positioned
 * by the printer from its left edge: a narrower canvas would print a centred line hard against the
 * margin. Its height is what the flow measured, so nothing is cropped and no blank paper is charged.
 *
 * @param nodes one line's nodes, as `splitLines` produced them
 * @param context the fonts, the paper and what the pre-pass resolved
 * @returns the dots, packed exactly as `GS v 0` takes them
 * @throws UnsupportedCharacterError under the `REJECT` policy, when a face has no such glyph
 * @throws MarkupError when the line carries something the printer draws for itself
 */
export function renderRasterLine(nodes: Node[], context: LayoutContext): ImageRaster {
	const width = dotWidth(context.columns);
	const flow = buildFlow(nodes, context);
	const canvas = new Canvas(width, Math.max(1, flow.measure(width).height));
	flow.paint(canvas, 0, 0, width);
	return canvas.pack();
}

/**
 * The dots an `<image>` occupies inside a drawn line.
 *
 * A tag with no width means the image's own size here rather than the whole paper's — see
 * `ImageSource.natural` — because it sits in a row of glyphs rather than owning a line. A tag that
 * does carry a width still means that share of the paper, and the pre-pass produced a raster for it.
 *
 * A missing raster is a fault on this side rather than a bad request, the same as a reference the
 * pre-pass never resolved: it sees the same lines this does, so the alternative is a receipt whose
 * picture was never charged against the budget bounding it.
 *
 * @param node the image tag, carrying its reference and the width it asked for
 * @param context the layout context, carrying the paper and what the pre-pass resolved
 * @returns the raster to place
 * @throws Error if the image was never resolved at the width this line draws it
 */
function rasterFor(node: ImageNode, context: LayoutContext): ImageRaster {
	const source = context.images.get(node.ref);
	const raster =
		node.widthPercent === null
			? source?.natural
			: source?.inline?.get(printedWidthDots(node.widthPercent, context.columns));
	if (!raster) {
		throw new Error(
			`The image '${node.ref}' was not resolved at the width this line draws it; resolveImages must run first`,
		);
	}
	return raster;
}

/**
 * One run of inline content, laid out as rows of glyphs.
 *
 * The rows are cached against the width they were measured at, because `measure` and `paint` are
 * two calls about one layout and breaking the text twice would be both wasteful and a chance for
 * the two to disagree.
 */
function inlineSequence(items: InlineItem[], align: Align, wrap: boolean, context: LayoutContext): LayoutNode {
	let measuredAt = -1;
	let rows: TextRow[] = [];

	const rowsAt = (availableWidth: number): TextRow[] => {
		if (measuredAt !== availableWidth) {
			rows = layoutText(items, availableWidth, wrap, align, context);
			measuredAt = availableWidth;
		}
		return rows;
	};

	return {
		measure(availableWidth) {
			const laid = rowsAt(availableWidth);
			return { width: laid.reduce((widest, row) => Math.max(widest, row.width), 0), height: textHeight(laid) };
		},
		paint(canvas, x, y, availableWidth) {
			paintRows(canvas, rowsAt(availableWidth), x, y);
		},
	};
}

/** A source line with nothing typed on it: draws nothing, but still holds one row of paper. */
function blankRowNode(height: number): LayoutNode {
	return {
		measure(availableWidth) {
			return { width: availableWidth, height };
		},
		paint() {},
	};
}

/** A `<hr>`: one printed line of paper with a rule through the middle of it. */
function ruleNode(): LayoutNode {
	return {
		measure(availableWidth) {
			return { width: availableWidth, height: RULE_HEIGHT_DOTS };
		},
		paint(canvas, x, y, availableWidth) {
			canvas.hLine(x, y + Math.floor(RULE_HEIGHT_DOTS / 2), availableWidth);
		},
	};
}

/**
 * The node that draws one block.
 *
 * @param node the block
 * @param context the fonts, the paper and what the pre-pass resolved
 * @returns the node that draws it
 * @throws Error if nothing here draws that tag
 */
function blockNode(node: BlockNode, context: LayoutContext): LayoutNode {
	switch (node.tag) {
		case "box":
			return new BoxNode(node, buildFlow(node.children, context));
		case "table":
			return new TableNode(node, context);
		case "bar":
			return new GaugeNode(node, context);
		case "chart":
			return new ChartNode(node, context);
		default:
			throw new Error(`no layout node draws <${node.tag}>`);
	}
}

/** A border's dots, from the box's own outer edge to where its padding begins. */
type BorderKind = "single" | "double" | "thick" | "none";
const BORDER_INSET: Record<BorderKind, number> = { single: 1, double: 4, thick: 3, none: 0 };

/** Dots one pad unit spans: half a character cell, which is as fine as `<box pad>` resolves. */
const PAD_UNIT_DOTS = 6;

/**
 * A framed region: a border drawn around the flow it encloses, with padding between the two.
 *
 * The border and the padding are both charged against the box's own width before the flow inside
 * ever sees it, which is what makes a nested box narrower than its parent by exactly what the
 * parent drew around it rather than by some share the child has to know to leave.
 */
class BoxNode implements LayoutNode {
	private readonly widthPercent: number;
	private readonly border: BorderKind;
	private readonly padDots: number;

	constructor(
		node: BlockNode,
		private readonly flow: LayoutNode,
	) {
		this.widthPercent = (node.attributes.width as number | undefined) ?? 100;
		this.border = (node.attributes.border as BorderKind | undefined) ?? "single";
		this.padDots = ((node.attributes.pad as number | undefined) ?? 1) * PAD_UNIT_DOTS;
	}

	/** The border and padding together, charged on every side. */
	private get inset(): number {
		return BORDER_INSET[this.border] + this.padDots;
	}

	measure(availableWidth: number): Size {
		const width = Math.floor((availableWidth * this.widthPercent) / 100);
		const inner = this.flow.measure(Math.max(0, width - 2 * this.inset));
		return { width, height: inner.height + 2 * this.inset };
	}

	paint(canvas: Canvas, x: number, y: number, availableWidth: number): void {
		const width = Math.floor((availableWidth * this.widthPercent) / 100);
		const inset = this.inset;
		const innerWidth = Math.max(0, width - 2 * inset);
		const height = this.flow.measure(innerWidth).height + 2 * inset;

		paintBorder(canvas, x, y, width, height, this.border);
		this.flow.paint(canvas, x + inset, y + inset, innerWidth);
	}
}

/** Draws an outline: `double` is two lines with the 2-dot gap between them left blank. */
function paintBorder(canvas: Canvas, x: number, y: number, width: number, height: number, border: BorderKind): void {
	switch (border) {
		case "none":
			return;
		case "single":
			canvas.rect(x, y, width, height, 1);
			return;
		case "thick":
			canvas.rect(x, y, width, height, 3);
			return;
		case "double":
			canvas.rect(x, y, width, height, 1);
			canvas.rect(x + 3, y + 3, width - 6, height - 6, 1);
			return;
	}
}

/** Dots the rule between two neighbouring cells occupies. */
const CELL_RULE_DOTS = 1;

/** Dots a `group` rule occupies, drawn over the cell rule it thickens. */
const GROUP_RULE_DOTS = 3;

/** How a cell is shaded behind its own content. */
type CellShade = "none" | "light" | "dark" | "black";

/** Where a cell's content sits when the row is taller than the content is. */
type CellVAlign = "top" | "middle" | "bottom";

/** One cell: the flow it draws, and everything about how that flow is placed and shaded. */
interface TableCell {
	flow: LayoutNode;
	shade: CellShade;
	valign: CellVAlign;
	/** The share of the table this cell's column claims, or null when it takes an equal one. */
	widthPercent: number | null;
	line: number;
	column: number;
}

/** What a table settles at for one available width. */
interface TableGrid {
	/** Dots per column, summing to the width inside the border. */
	columns: number[];
	/** Dots per row, each already carrying its own padding. */
	rows: number[];
	width: number;
	height: number;
}

/** One rule between two tracks: where it falls, and which track it comes before. */
interface Rule {
	index: number;
	at: number;
}

/**
 * A grid of rows and cells.
 *
 * **A column is a share of the table rather than a width of its own.** Nothing in a cell says how
 * wide it should be — a receipt's paper is fixed and its columns have to fit that paper, not the
 * other way round — so the first row's `width` attributes claim percentages and every column that
 * claimed nothing splits what is left. That split is the same one `<fill>` performs between two
 * padded gaps, and for the same reason: the remainder has to land somewhere, and where it lands
 * has to be decided the same way every time.
 *
 * Rules run inside the columns rather than between them. A row's height is content, so the rule
 * under it needs a dot of its own and the table grows by one; a column's width is a share of a
 * width already fixed, so a rule that took its own dot would push the table past the paper it was
 * cut to fit. Each column's first dot carries the rule that precedes it instead, which is inside
 * that column's padding and so never touches its content.
 */
class TableNode implements LayoutNode {
	private readonly widthPercent: number;
	private readonly border: BorderKind;
	private readonly group: number | null;
	private readonly rows: TableCell[][];
	private readonly columnCount: number;
	private measuredAt = -1;
	private grid: TableGrid = { columns: [], rows: [], width: 0, height: 0 };

	constructor(node: BlockNode, context: LayoutContext) {
		this.widthPercent = (node.attributes.width as number | undefined) ?? 100;
		this.border = (node.attributes.border as BorderKind | undefined) ?? "single";
		this.group = (node.attributes.group as number | undefined) ?? null;
		this.rows = childBlocks(node, "row").map((row) =>
			childBlocks(row, "cell").map((cell) => ({
				flow: buildFlow(cell.children, context, cellAlign(cell)),
				shade: (cell.attributes.shade as CellShade | undefined) ?? "none",
				valign: (cell.attributes.valign as CellVAlign | undefined) ?? "middle",
				widthPercent: (cell.attributes.width as number | undefined) ?? null,
				line: cell.line,
				column: cell.column,
			})),
		);
		// The longest row: a short row leaves empty cells rather than widening the ones it has, so
		// that two rows of a table line up even when one of them stops early.
		this.columnCount = this.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
	}

	measure(availableWidth: number): Size {
		const grid = this.gridAt(availableWidth);
		return { width: grid.width, height: grid.height };
	}

	paint(canvas: Canvas, x: number, y: number, availableWidth: number): void {
		const grid = this.gridAt(availableWidth);
		const inset = BORDER_INSET[this.border];
		const left = x + inset;
		const top = y + inset;
		const across = grid.width - 2 * inset;
		const down = grid.height - 2 * inset;

		let cellTop = top;
		for (const [index, row] of this.rows.entries()) {
			let cellLeft = left;
			for (let column = 0; column < this.columnCount; column++) {
				const cell = row[column];
				if (cell) {
					paintCell(canvas, cell, cellLeft, cellTop, grid.columns[column], grid.rows[index]);
				}
				cellLeft += grid.columns[column];
			}
			cellTop += grid.rows[index] + CELL_RULE_DOTS;
		}

		const rowRules = tracks(grid.rows, top, CELL_RULE_DOTS);
		const columnRules = tracks(grid.columns, left, 0);
		paintBorder(canvas, x, y, grid.width, grid.height, this.border);
		for (const rule of rowRules) {
			canvas.hLine(left, rule.at, across, CELL_RULE_DOTS);
		}
		for (const rule of columnRules) {
			canvas.vLine(rule.at, top, down, CELL_RULE_DOTS);
		}

		// Drawn last and over the plain rules, so a group's edge reads as one thick line rather than
		// as a thin one with something beside it.
		const group = this.group;
		if (group === null) {
			return;
		}
		for (const rule of rowRules.filter((rule) => rule.index % group === 0)) {
			canvas.hLine(left, rule.at - 1, across, GROUP_RULE_DOTS);
		}
		for (const rule of columnRules.filter((rule) => rule.index % group === 0)) {
			canvas.vLine(rule.at - 1, top, down, GROUP_RULE_DOTS);
		}
	}

	/** The grid for this width, laid out once and kept, the way an inline sequence keeps its rows. */
	private gridAt(availableWidth: number): TableGrid {
		if (this.measuredAt !== availableWidth) {
			this.grid = this.layOut(availableWidth);
			this.measuredAt = availableWidth;
		}
		return this.grid;
	}

	private layOut(availableWidth: number): TableGrid {
		const inset = BORDER_INSET[this.border];
		const width = Math.floor((availableWidth * this.widthPercent) / 100);
		const columns = this.columnWidths(Math.max(0, width - 2 * inset));
		const rows = this.rows.map(
			(row) =>
				row.reduce(
					(tallest, cell, index) => Math.max(tallest, cell.flow.measure(cellWidth(columns[index] ?? 0)).height),
					0,
				) +
				2 * PAD_UNIT_DOTS,
		);

		return {
			columns,
			rows,
			width: 2 * inset + total(columns),
			height: 2 * inset + total(rows) + Math.max(0, rows.length - 1) * CELL_RULE_DOTS,
		};
	}

	/**
	 * Dots per column, from the first row's claims and an equal split of what they leave.
	 *
	 * @param inner the dots inside the border, which the columns divide between them
	 * @returns one width per column, in order
	 * @throws MarkupError when the claims come to more than the whole table
	 */
	private columnWidths(inner: number): number[] {
		const claims = Array.from({ length: this.columnCount }, (_, index) => this.rows[0]?.[index]?.widthPercent ?? null);
		let claimed = 0;
		for (const [index, percent] of claims.entries()) {
			claimed += percent ?? 0;
			if (claimed > 100) {
				const cell = this.rows[0][index];
				throw new MarkupError(
					MARKUP_ERRORS.invalidAttribute,
					cell.line,
					cell.column,
					"width",
					`a table has only its own width to divide up, and the sized columns add up to ${claimed}%`,
				);
			}
		}

		const widths = claims.map((percent) => (percent === null ? 0 : Math.floor((inner * percent) / 100)));
		const unsized = claims.filter((percent) => percent === null).length;
		if (unsized > 0) {
			const equal = share(Math.max(0, inner - total(widths)), unsized);
			let next = 0;
			for (const [index, percent] of claims.entries()) {
				if (percent === null) {
					widths[index] = equal[next++];
				}
			}
		}
		return widths;
	}
}

/** Dots between the outlined bar and the number that follows it. */
const GAUGE_GAP_DOTS = 12;

/**
 * A one-line gauge: an outlined bar hatched to a percentage, with the percentage itself set after
 * a gap.
 *
 * The number is measured once, at construction, rather than at every `measure`/`paint` call: it is
 * plain text in a fixed face, so nothing about it can change with the width the gauge is offered,
 * unlike a box or table whose content reflows.
 */
class GaugeNode implements LayoutNode {
	private readonly widthPercent: number;
	private readonly percent: number;
	private readonly numberRows: TextRow[];
	private readonly numberWidth: number;

	constructor(node: BlockNode, context: LayoutContext) {
		this.widthPercent = (node.attributes.width as number | undefined) ?? 100;
		this.percent = node.attributes.value as number;
		// The parsed number rather than the text it was written as: `<bar value=038>` is thirty-eight
		// full, and a gauge that printed "038%" beside a bar drawn to 38 would be reporting two things.
		const items: InlineItem[] = [{ kind: "run", text: `${this.percent}%`, style: PLAIN, column: node.column }];
		this.numberRows = layoutText(items, Number.MAX_SAFE_INTEGER, false, "LEFT", context);
		this.numberWidth = this.numberRows.reduce((widest, row) => Math.max(widest, row.width), 0);
	}

	measure(availableWidth: number): Size {
		return { width: Math.floor((availableWidth * this.widthPercent) / 100), height: LINE_HEIGHT_DOTS };
	}

	paint(canvas: Canvas, x: number, y: number, availableWidth: number): void {
		const width = Math.floor((availableWidth * this.widthPercent) / 100);
		const barWidth = Math.max(0, width - this.numberWidth - GAUGE_GAP_DOTS);

		canvas.rect(x, y, barWidth, LINE_HEIGHT_DOTS, 1);
		const innerWidth = Math.max(0, barWidth - 2);
		const filled = Math.round((innerWidth * this.percent) / 100);
		canvas.fill(x + 1, y + 1, filled, LINE_HEIGHT_DOTS - 2, "hatch");

		const textTop = y + Math.floor((LINE_HEIGHT_DOTS - textHeight(this.numberRows)) / 2);
		paintRows(canvas, this.numberRows, x + barWidth + GAUGE_GAP_DOTS, textTop);
	}
}

/**
 * A plotted chart.
 *
 * The height is the author's rather than the content's: a chart is a picture of numbers, and how
 * tall it stands says how prominent it is on the receipt rather than how much there is to draw. So
 * unlike a box or a table, nothing about what it holds can change what it costs.
 */
class ChartNode implements LayoutNode {
	private readonly widthPercent: number;
	private readonly chart: ChartData;

	constructor(
		node: BlockNode,
		private readonly context: LayoutContext,
	) {
		this.widthPercent = (node.attributes.width as number | undefined) ?? 100;
		if (!node.chart) {
			// Every chart the tree builds carries its data: it is read when the chart closes, from the
			// same tags this node is built from. A chart without it was assembled by hand.
			throw new Error("a <chart> reached the layout without the series the tree reads on its close");
		}
		this.chart = node.chart;
	}

	measure(availableWidth: number): Size {
		return { width: this.width(availableWidth), height: chartHeight(this.chart) };
	}

	paint(canvas: Canvas, x: number, y: number, availableWidth: number): void {
		paintChart(canvas, this.chart, x, y, this.width(availableWidth), this.context);
	}

	private width(availableWidth: number): number {
		return Math.floor((availableWidth * this.widthPercent) / 100);
	}
}

/** The blocks of one tag directly inside another, in source order. */
function childBlocks(node: BlockNode, tag: BlockTag): BlockNode[] {
	return node.children.filter((child): child is BlockNode => child.kind === "block" && child.tag === tag);
}

/** The justification a cell's content is laid out under. */
function cellAlign(cell: BlockNode): Align {
	return ((cell.attributes.align as string | undefined) ?? "left").toUpperCase() as Align;
}

/** The dots a cell's content has, once a half-cell of padding is charged on each side. */
function cellWidth(columnWidth: number): number {
	return Math.max(0, columnWidth - 2 * PAD_UNIT_DOTS);
}

function total(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0);
}

/**
 * Where the rules between a run of tracks fall.
 *
 * @param sizes the tracks' dots, in order
 * @param start where the first track begins
 * @param gap dots between two tracks, which a rule of its own occupies and a shared one does not
 * @returns one rule per boundary, each carrying the index of the track it comes before
 */
function tracks(sizes: number[], start: number, gap: number): Rule[] {
	const rules: Rule[] = [];
	let at = start;
	for (let index = 0; index < sizes.length - 1; index++) {
		at += sizes[index];
		rules.push({ index: index + 1, at });
		at += gap;
	}
	return rules;
}

/**
 * Draws one cell: its shading, then its content within it.
 *
 * `black` is two inversions around one drawing rather than white ink, because there is no white
 * ink: a glyph is painted by setting dots. The cell is filled solid, the content rectangle is
 * inverted back to blank so the flow has somewhere to draw, and inverting that rectangle again
 * once the flow has drawn turns its dots into the unlit ones — white text, on the black the rest
 * of the fill left standing.
 */
function paintCell(canvas: Canvas, cell: TableCell, x: number, y: number, width: number, height: number): void {
	const innerX = x + PAD_UNIT_DOTS;
	const innerY = y + PAD_UNIT_DOTS;
	const innerWidth = cellWidth(width);
	const innerHeight = Math.max(0, height - 2 * PAD_UNIT_DOTS);

	if (cell.shade === "light" || cell.shade === "dark") {
		canvas.fill(x, y, width, height, cell.shade);
	} else if (cell.shade === "black") {
		canvas.fill(x, y, width, height, "solid");
		canvas.invert(innerX, innerY, innerWidth, innerHeight);
	}

	const slack = Math.max(0, innerHeight - cell.flow.measure(innerWidth).height);
	const offset = cell.valign === "top" ? 0 : cell.valign === "bottom" ? slack : Math.floor(slack / 2);
	cell.flow.paint(canvas, innerX, innerY + offset, innerWidth);

	if (cell.shade === "black") {
		canvas.invert(innerX, innerY, innerWidth, innerHeight);
	}
}

/**
 * Puts children one under another, each offered the whole width.
 *
 * A block child is narrower than what it is offered whenever its own width attribute says so, and
 * placed within that width by the align in force where it sat — `0`, half the leftover dots, or all
 * of them — the same three positions a native line's own justification chooses between. An inline
 * sequence already chose its own placement while it laid out its rows, so it is always painted flush
 * with the flow's own left edge.
 */
function stack(children: FlowChild[]): LayoutNode {
	return {
		measure(availableWidth) {
			let width = 0;
			let height = 0;
			for (const { node } of children) {
				const size = node.measure(availableWidth);
				width = Math.max(width, size.width);
				height += size.height;
			}
			return { width, height };
		},
		paint(canvas, x, y, availableWidth) {
			let top = y;
			for (const { node, align } of children) {
				const size = node.measure(availableWidth);
				const offset =
					align === "CENTER"
						? Math.floor((availableWidth - size.width) / 2)
						: align === "RIGHT"
							? availableWidth - size.width
							: 0;
				node.paint(canvas, x + offset, top, availableWidth);
				top += size.height;
			}
		},
	};
}
