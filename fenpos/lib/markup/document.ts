import type { Align } from "@/lib/domain/enums";
import type { Attributes } from "@/lib/markup/attributes";
import type { SymbolSpec } from "@/lib/markup/blocks";
import type { SpanStyle } from "@/lib/markup/model";

/**
 * A whole `data` document as a tree of nodes.
 *
 * The tree is the one place the shape rules live. Whether `<align>` owns its line, whether a rule
 * shares a line with text, whether a tag closes the tag that is open — every such question is
 * answered once, while the tree is built, and never again. Everything downstream reads a tree that
 * is already known to be well formed, which is what keeps the same rule from being checked twice
 * with two slightly different answers.
 *
 * Two consumers read it. The flattener turns it into the printed lines of styled spans the
 * compiler and the renderer already understand, resolving each node's style by descending through
 * the scopes that enclose it. The layout engine reads the block nodes, which carry geometry rather
 * than text and are measured against the paper instead of being flattened.
 *
 * Every node carries the line and column it was written at, because that is what a `400` needs in
 * order to be worth reading — the same reason spans carry a source column.
 */

/**
 * The variable values one compile may substitute.
 *
 * Handed in rather than read, because tokenizing is synchronous and the values are database rows —
 * the same reason `<image>` geometry arrives through `CompileSettings`. See `resolveVariables` in
 * `lib/markup/resolve-variables.ts` for where it is built.
 */
export interface VariableContext {
	/** Every name this compile can resolve, already flattened across the three layers. */
	values: ReadonlyMap<string, string>;
	/** How many references one line may contain. */
	maxPerElement: number;
}

/**
 * The limits one document is parsed under.
 *
 * Bounds rather than preferences: each one is the point past which a document would cost more to
 * build than any receipt could justify, so they exist to stop one request from spending the
 * server's memory rather than to shape what a caller may write.
 */
export interface ParseOptions {
	maxBlockDepth: number;
	maxTableCells: number;
	maxSeriesPoints: number;
	maxFontHeight: number;
}

/** The limits a caller gets without asking. */
export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
	maxBlockDepth: 16,
	maxTableCells: 2000,
	maxSeriesPoints: 2000,
	maxFontHeight: 512,
};

/** Where a node was written, 1-based in both directions. */
interface Located {
	line: number;
	column: number;
}

/** A run of text sharing one position in the source. */
export interface TextNode extends Located {
	kind: "text";
	text: string;
	/**
	 * The variable whose value produced this text, when it arrived by substitution.
	 *
	 * Within a substituted run there is no arithmetic from {@link Located.column} that can be right,
	 * because the reference and the value are different lengths. `columnAt` reads this mark to stop
	 * trying and name the variable instead.
	 */
	expandedFrom?: string;
}

/** The end of a printed line. */
export interface BreakNode extends Located {
	kind: "break";
}

/** The tags that style the text they enclose without owning the line. */
export type ScopeTag = "bold" | "underline" | "invert" | "size" | "font";

/**
 * A styling tag and everything it encloses.
 *
 * Carries the patch the tag applies rather than the style that results from it, so a node's style
 * is the fold of the patches above it. Storing the resolved style instead would duplicate every
 * enclosing tag's decision into every node and let the two disagree.
 */
export interface ScopeNode extends Located {
	kind: "scope";
	tag: ScopeTag;
	patch: Partial<SpanStyle>;
	children: Node[];
}

/** An alignment tag and the lines it owns. */
export interface AlignNode extends Located {
	kind: "align";
	align: Align;
	children: Node[];
}

/** A `<wrap>` or `<nowrap>` and the lines it owns. */
export interface WrapNode extends Located {
	kind: "wrap";
	wrap: boolean;
	children: Node[];
}

/**
 * A pad to the paper's width.
 *
 * Carries no style of its own: the style it prints in is the one its enclosing scopes resolve to,
 * which is the same rule every other node here follows.
 */
export interface FillNode extends Located {
	kind: "fill";
	character: string;
}

/** A printer action that encloses nothing. */
export type VoidDirective =
	| { kind: "CUT"; mode: "FULL" | "PARTIAL" }
	| { kind: "FEED"; lines: number }
	| { kind: "DRAWER"; pin: 2 | 5 };

/** One of the tags that act on the printer rather than print. */
export interface VoidNode extends Located {
	kind: "void";
	directive: VoidDirective;
}

/** A full-width horizontal rule. */
export interface RuleNode extends Located {
	kind: "rule";
}

/**
 * A validated symbol, still unmeasured.
 *
 * Measuring needs an encoder, and the tree deliberately has none: the same tree is built wherever
 * markup is parsed, while only this side can encode. What is checked here is the content's format,
 * which is a property of the markup and so belongs with the rest of the shape rules.
 */
export interface SymbolNode extends Located {
	kind: "symbol";
	spec: SymbolSpec;
}

/**
 * Where an image's dots come from: a stored asset or URL by name, or bytes decoded from a data URI
 * already written into the document.
 *
 * Kept apart from {@link ImageNode.ref}, which stays the raw content a pre-pass keys its map by, so
 * a later stage can read `source` for the bytes without re-parsing the URI `ref` still carries.
 */
export type ImageSourceRef =
	| { kind: "named"; name: string }
	| { kind: "data"; mimeType: "image/png" | "image/jpeg"; bytes: Buffer };

/**
 * A stored image's name, an `http(s)` URL, or an inline data URI.
 *
 * `widthPercent` is null when the tag carried no argument, which means the whole printable width.
 * Null rather than the default filled in, so a later stage can tell a caller who asked for 100
 * from one who asked for nothing.
 */
export interface ImageNode extends Located {
	kind: "image";
	ref: string;
	source: ImageSourceRef;
	widthPercent: number | null;
}

/** The tags that lay out a region of the paper rather than a run of text. */
export type BlockTag = "box" | "table" | "row" | "cell" | "chart" | "series" | "labels" | "bar";

/** What a `<chart>` is drawn as. */
export type ChartType = "bar" | "line" | "pie" | "scatter";

/**
 * One series of a chart, read from the text a `<series>` enclosed.
 *
 * `values` always holds the numbers the series plots; `points` holds the same numbers paired up for
 * a scatter, and is null for every other chart. Both rather than one, so a caller that only needs
 * the magnitudes — the y axis, the legend — reads them the same way whatever the chart is.
 */
export interface Series {
	/** What the legend prints for this series, or null when the tag carried no argument. */
	label: string | null;
	pattern: "solid" | "hatch" | "dot" | "hollow";
	marker: "circle" | "square" | "triangle" | "cross" | "none";
	values: number[];
	points: [number, number][] | null;
}

/**
 * Everything a chart plots, read off its tags once the whole chart is known.
 *
 * Kept apart from the attributes it came from because a chart's shape is a fact about all of its
 * tags together — how many series there are decides whether the legend is drawn, how long the
 * longest one is decides how many labels fit — and none of that can be settled one tag at a time.
 */
export interface ChartData {
	type: ChartType;
	title: string | null;
	/** Printed lines the whole chart occupies, including its title and axes. */
	height: number;
	legend: "auto" | "on" | "off";
	area: boolean;
	series: Series[];
	labels: string[];
}

/**
 * A laid-out region and everything it encloses.
 *
 * `content` holds the text of a block that encloses data rather than markup; `children` holds the
 * nodes of one that encloses markup. A block never has both.
 */
export interface BlockNode extends Located {
	kind: "block";
	tag: BlockTag;
	argument: string | null;
	attributes: Attributes;
	content: string | null;
	children: Node[];
	/** What this chart plots, on a `chart` block; absent on every other. */
	chart?: ChartData;
}

/** Anything a document can hold. */
export type Node =
	| TextNode
	| BreakNode
	| ScopeNode
	| AlignNode
	| WrapNode
	| FillNode
	| VoidNode
	| RuleNode
	| SymbolNode
	| ImageNode
	| BlockNode;

/**
 * One source line, and what is known about it before anything is printed.
 *
 * `chars` is the raw length, for the per-line character limit, and is counted from the source
 * rather than from the nodes because a tag costs a caller characters without printing any.
 * `interior` marks a line swallowed by a tag that encloses data: it produces no printed line of
 * its own, so nothing may charge it against the job's line budget.
 */
export interface LineInfo {
	number: number;
	chars: number;
	interior: boolean;
}

/** A whole document: its nodes, and the source lines they came from. */
export interface Document {
	nodes: Node[];
	lines: LineInfo[];
}
