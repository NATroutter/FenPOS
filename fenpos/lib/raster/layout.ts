import type { ImageRaster } from "@/lib/assets/dither";
import type { Align } from "@/lib/domain/enums";
import { dotWidth, LINE_HEIGHT_DOTS } from "@/lib/markup/blocks";
import type { BlockNode, ImageNode, Node } from "@/lib/markup/document";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import { printedWidthDots, type ResolvedImages } from "@/lib/markup/images";
import { PLAIN, type SpanStyle } from "@/lib/markup/model";
import { Canvas } from "@/lib/raster/canvas";
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
 * @returns the node that draws them
 */
export function buildFlow(nodes: Node[], context: LayoutContext): LayoutNode {
	const children: FlowChild[] = [];
	let items: InlineItem[] = [];

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
					items.push({
						kind: "run",
						text: node.text,
						style,
						column: node.column,
						...(node.expandedFrom === undefined ? {} : { expandedFrom: node.expandedFrom }),
					});
					break;
				case "fill":
					items.push({ kind: "fill", character: node.character, style, column: node.column });
					break;
				case "image":
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
					closeSequence(align, wrap);
					children.push({ node: ruleNode(), align: "LEFT" });
					break;
				case "block":
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
					// block's source lines into its own row.
					closeSequence(align, wrap);
					break;
			}
		}
	};

	visit(nodes, PLAIN, "LEFT", context.defaultWrap);
	closeSequence("LEFT", context.defaultWrap);

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

		this.paintBorder(canvas, x, y, width, height);
		this.flow.paint(canvas, x + inset, y + inset, innerWidth);
	}

	/** Draws the outline itself: `double` is two lines with the 2-dot gap between them left blank. */
	private paintBorder(canvas: Canvas, x: number, y: number, width: number, height: number): void {
		switch (this.border) {
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
