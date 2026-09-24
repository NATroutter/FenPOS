import {
	pdf417Columns,
	SymbolEncodeError,
	type SymbolGeometry,
	type SymbolSpec,
	symbolGeometry,
} from "@/lib/markup/blocks";
import type { Node } from "@/lib/markup/document";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import { expandList } from "@/lib/markup/lists";
import { type Directive, type Line, PLAIN, type SpanStyle } from "@/lib/markup/model";

/**
 * Turns a document's tree into the printed lines the compiler and the renderer already understand.
 *
 * The tree says what the document is; this says what each line of it prints. Nothing is checked
 * here — every shape rule was settled while the tree was built — so the only decisions left are
 * arithmetic ones: which line a node belongs to, what style the scopes above it resolve to, and how
 * many dots a symbol takes.
 *
 * Measuring is the one thing this stage does that the tree cannot. A symbol's size needs an encoder,
 * and the same tree is built wherever markup is parsed while only the server can encode, so the
 * geometry is attached here and nowhere else.
 */

/** One line of the document as the compiler sees it: its number and the nodes on it. */
export interface TopLine {
	number: number;
	nodes: Node[];
	/**
	 * Columns a wrapped continuation of this line begins at, zero for every line but a list's.
	 *
	 * A hanging indent, and the only property of a printed line that the render model does not carry:
	 * it is spent by the wrapper and by the inline flow and neither the wire nor the agent has any use
	 * for it, so it travels beside the line rather than on it — which is also what keeps `Line` the
	 * same shape as the `Line.java` it was ported from.
	 */
	indent: number;
}

/**
 * Splits a tree at its breaks, expanding every list into the lines it prints.
 *
 * A scope that spans lines is copied onto every line it covers with only that line's children, so
 * each line can be flattened on its own and still carry the style. Blocks are atomic: their breaks
 * belong to the layout engine. A tag enclosing data that spans lines leaves no break behind for the
 * lines it swallows — they print nothing — so the line number of what follows comes from the break
 * that ends its closing line, not from counting the parts produced so far.
 *
 * **A list is turned into ordinary lines here and nowhere else.** One entry is one line of a marker
 * and the entry's text, and a nested list is more of the same further in, so once the expansion has
 * run nothing downstream — the raster test, the flattener, the image pre-pass that walks these same
 * lines — has to know that lists exist.
 *
 * @param nodes a document's nodes
 * @returns one entry per printed line, in order
 */
export function splitLines(nodes: Node[]): TopLine[] {
	return splitAtBreaks(nodes, 1);
}

function splitAtBreaks(nodes: Node[], firstNumber: number): TopLine[] {
	const lines: TopLine[] = [blankLine(firstNumber)];
	const current = (): TopLine => lines[lines.length - 1];
	for (const node of nodes) {
		if (node.kind === "break") {
			lines.push(blankLine(node.line + 1));
			continue;
		}
		if (node.kind === "scope" || node.kind === "align" || node.kind === "wrap") {
			const inner = splitAtBreaks(node.children, current().number);
			inner.forEach((part, index) => {
				if (index > 0) {
					lines.push(blankLine(part.number));
				}
				current().nodes.push({ ...node, children: part.nodes });
				// Carried out of the recursion: a list inside an `<align>` still hangs its wrapped rows
				// under its own text, and the wrapper is handed the line rather than the tree.
				current().indent = part.indent;
			});
			continue;
		}
		if (node.kind === "list") {
			// The list owns the line it opened on, so the first of its own lines takes that line over
			// rather than leaving a blank one above it. The rest follow as lines in their own right.
			expandList(node, 0).forEach((draft, index) => {
				if (index > 0 || current().nodes.length > 0) {
					lines.push(blankLine(draft.line));
				}
				current().number = draft.line;
				current().nodes.push(...draft.nodes);
				current().indent = draft.indent;
			});
			continue;
		}
		current().nodes.push(node);
	}
	return lines;
}

function blankLine(number: number): TopLine {
	return { number, nodes: [], indent: 0 };
}

/**
 * Whether a line needs the layout engine.
 *
 * The printer draws text in its own fonts, symbols, and a whole-line image itself. Anything else —
 * a block, an image beside text, a configured font — it cannot, so the server draws the line into a
 * raster instead.
 *
 * @param nodes one line's nodes
 * @returns true when the line has to be rasterised
 */
export function needsRaster(nodes: Node[]): boolean {
	let images = 0;
	let other = 0;
	let raster = false;
	const walkNodes = (list: Node[]): void => {
		for (const node of list) {
			switch (node.kind) {
				case "block":
				// A checkbox is dots this side draws, so its line cannot be sent as characters.
				case "check":
					raster = true;
					break;
				case "image":
					images += 1;
					break;
				case "scope":
					if (node.patch.face) {
						raster = true;
					}
					walkNodes(node.children);
					break;
				case "align":
				case "wrap":
					walkNodes(node.children);
					break;
				case "text":
				case "fill":
					other += 1;
					break;
				case "list":
				case "item":
					throw new Error("splitLines expands every list into ordinary lines");
				default:
					break;
			}
		}
	};
	walkNodes(nodes);
	return raster || (images > 0 && (images > 1 || other > 0));
}

/**
 * Flattens one native line into the render model.
 *
 * The result is exactly what the single-pass parser produced for the same line: spans in order with
 * their source columns, fills counted by the spans before them, directives in order, and the align
 * and wrap the line's owners set.
 *
 * @param nodes one line's nodes, as {@link splitLines} produced them
 * @returns the line, ready for the charset check and the fill resolver
 * @throws MarkupError if a symbol's content is one the encoder refuses
 */
export function flattenLine(nodes: Node[]): Line {
	const line: Line = { align: "LEFT", wrap: null, spans: [], fills: [], directives: [] };
	walk(nodes, PLAIN, line);
	return line;
}

function walk(nodes: Node[], style: SpanStyle, line: Line): void {
	for (const node of nodes) {
		switch (node.kind) {
			case "text":
				line.spans.push({
					text: node.text,
					style,
					sourceColumn: node.column,
					...(node.expandedFrom === undefined ? {} : { expandedFrom: node.expandedFrom }),
				});
				break;
			case "fill":
				line.fills.push({
					afterSpans: line.spans.length,
					character: node.character,
					style,
					sourceColumn: node.column,
				});
				break;
			case "scope":
				walk(node.children, { ...style, ...node.patch }, line);
				break;
			case "align":
				line.align = node.align;
				walk(node.children, style, line);
				break;
			case "wrap":
				line.wrap = node.wrap;
				walk(node.children, style, line);
				break;
			case "void":
				line.directives.push(node.directive);
				break;
			case "rule":
				line.directives.push({ kind: "RULE", character: node.character, sourceColumn: node.column });
				break;
			case "symbol":
				line.directives.push(measured(node.spec, node.line, node.column));
				break;
			case "image":
				// Null means the tag carried no width, which is the whole printable width. The tree keeps
				// the two apart so a later stage can tell a caller who asked for 100 from one who asked
				// for nothing; a native line has no such stage, so the default is filled in here.
				line.directives.push({ kind: "IMAGE", ref: node.ref, widthPercent: node.widthPercent ?? 100 });
				break;
			case "block":
				throw new Error("a block cannot be flattened to a native line");
			case "check":
				throw new Error("a checkbox cannot be flattened to a native line");
			case "list":
			case "item":
				throw new Error("splitLines expands every list into ordinary lines");
			case "break":
				throw new Error("splitLines removes every break");
		}
	}
}

/**
 * Measures a symbol and turns it into the directive that carries it.
 *
 * The size comes from {@link symbolGeometry} rather than from anything computed here, so the paper
 * the compiler's budget charges for a symbol, and the height and width the preview draws it at, are
 * the same measurement by construction.
 *
 * The opening tag's position travels with it, because the compiler is where a symbol is finally
 * compared against the paper's width and by then the source is gone.
 *
 * @param spec the validated symbol
 * @param line the line its opening tag was written on
 * @param column the column its opening tag was written at
 * @returns the directive to append to the line
 * @throws MarkupError if the encoder refuses this content
 */
function measured(spec: SymbolSpec, line: number, column: number): Directive {
	const geometry = encode(spec, line, column);
	const size = { heightLines: geometry.heightLines, widthDots: geometry.widthDots, sourceColumn: column };
	switch (spec.kind) {
		case "QR":
			return { kind: "QR", content: spec.content, size: spec.size, ...size };
		case "BARCODE":
			return { kind: "BARCODE", system: spec.system, content: spec.content, ...size };
		case "PDF417":
			return {
				kind: "PDF417",
				content: spec.content,
				errorLevel: spec.errorLevel,
				columns: pdf417Columns(geometry.widthDots),
				...size,
			};
	}
}

/**
 * Measures the symbol, turning an encoder refusal into a markup error.
 *
 * `validateSymbolContent` checks format only — length and alphabet — because check-digit arithmetic
 * belongs to the encoder that computes it. When the encoder is the one to refuse, the caller still
 * deserves a 400 naming the tag rather than an unhandled fault.
 *
 * Only a {@link SymbolEncodeError} is converted. Anything else thrown while measuring is a fault on
 * this side, and reporting it as a 400 would both tell the caller to fix content that is fine and
 * hide a server defect from the error rate that is supposed to show it.
 */
function encode(spec: SymbolSpec, line: number, column: number): SymbolGeometry {
	try {
		return symbolGeometry(spec);
	} catch (thrown) {
		if (!(thrown instanceof SymbolEncodeError)) {
			throw thrown;
		}
		const name = spec.kind.toLowerCase();
		throw new MarkupError(
			MARKUP_ERRORS.invalidTagArgument,
			line,
			column,
			name,
			`<${name}> cannot encode this content: ${thrown.message}`,
		);
	}
}
