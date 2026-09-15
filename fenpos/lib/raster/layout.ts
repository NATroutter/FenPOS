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

/**
 * Stacks a line's nodes top to bottom.
 *
 * **The grouping is what makes a drawn line look like a printed one.** Consecutive inline nodes —
 * text, fills, scopes, images, and the align and wrap wrappers around them — are one sequence, laid
 * out by `layoutText` exactly as the same characters would have been laid out in columns. A rule or a
 * block breaks the sequence, because neither is something that can sit in a row of glyphs, and each
 * becomes a child of its own. So `a<hr>b` is three children and `<bold>a</bold> b` is one.
 *
 * @param nodes one line's nodes, as `splitLines` produced them
 * @param context the fonts, the paper and what the pre-pass resolved
 * @returns the node that draws them
 */
export function buildFlow(nodes: Node[], context: LayoutContext): LayoutNode {
	const children: LayoutNode[] = [];
	let items: InlineItem[] = [];
	let align: Align = "LEFT";
	let wrap = context.defaultWrap;

	const closeSequence = (): void => {
		if (items.length > 0) {
			children.push(inlineSequence(items, align, wrap, context));
		}
		items = [];
		align = "LEFT";
		wrap = context.defaultWrap;
	};

	const visit = (list: Node[], style: SpanStyle): void => {
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
					visit(node.children, { ...style, ...node.patch });
					break;
				case "align":
					// The innermost wrapper wins, which is the same rule a native line follows: the tree
					// allows only one of each per line, so the last one assigned is the only one written.
					align = node.align;
					visit(node.children, style);
					break;
				case "wrap":
					wrap = node.wrap;
					visit(node.children, style);
					break;
				case "rule":
					closeSequence();
					children.push(ruleNode());
					break;
				case "block":
					closeSequence();
					children.push(blockNode(node, context));
					break;
				case "symbol":
				case "void": {
					// The tree is where this belongs, since it is a shape rule rather than a drawing one.
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
					throw new Error("splitLines removes every break");
			}
		}
	};

	visit(nodes, PLAIN);
	closeSequence();

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
function blockNode(node: BlockNode, _context: LayoutContext): LayoutNode {
	switch (node.tag) {
		default:
			throw new Error(`no layout node draws <${node.tag}>`);
	}
}

/** Puts children one under another, each offered the whole width. */
function stack(children: LayoutNode[]): LayoutNode {
	return {
		measure(availableWidth) {
			let width = 0;
			let height = 0;
			for (const child of children) {
				const size = child.measure(availableWidth);
				width = Math.max(width, size.width);
				height += size.height;
			}
			return { width, height };
		},
		paint(canvas, x, y, availableWidth) {
			let top = y;
			for (const child of children) {
				child.paint(canvas, x, top, availableWidth);
				top += child.measure(availableWidth).height;
			}
		},
	};
}
