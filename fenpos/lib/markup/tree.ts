import { Align, BarcodeSystem, Font } from "@/lib/domain/enums";
import { NAME_PATTERN } from "@/lib/domain/naming";
import { type Attributes, type RawAttribute, readAttributes } from "@/lib/markup/attributes";
import { type SymbolSpec, validateSymbolContent } from "@/lib/markup/blocks";
import type {
	AlignNode,
	BlockNode,
	BlockTag,
	Document,
	ImageNode,
	ImageSourceRef,
	LineInfo,
	Node,
	ParseOptions,
	ScopeNode,
	ScopeTag,
	SymbolNode,
	VoidDirective,
	WrapNode,
} from "@/lib/markup/document";
import { MARKUP_ERRORS, MarkupError, type MarkupErrorCode } from "@/lib/markup/errors";
import type { SpanStyle } from "@/lib/markup/model";
import { isBlockTag, TAGS, type Tag, tagByName } from "@/lib/markup/tags";
import type { Token, Tokenized } from "@/lib/markup/tokenizer";

/**
 * Turns a tokenized document into a tree, refusing every shape the language does not allow.
 *
 * **This is the boundary that makes the rest of the system safe.** The tokenizer guarantees that
 * nothing reaches a printer as a command except through a recognised tag; this guarantees that the
 * tag was allowed to be there. Both halves are needed, and keeping them apart is what lets each be
 * read on its own: one is about characters, this is about structure.
 *
 * Every rule is checked exactly once, here. A tag's argument, its attributes, whether it may open
 * where it opened, whether it closes what is open, whether a rule shares its line — all of it is
 * settled before a node exists, so nothing downstream has to ask again and nothing downstream can
 * answer differently.
 *
 * What is deliberately *not* checked here is anything that needs a device. How wide the paper is,
 * how many dots a symbol takes, whether an image can be fetched: those are properties of the
 * printer rather than of the markup, and a tree is built the same way wherever markup is parsed.
 */

/** Highest permitted character multiplier, imposed by ESC/POS `GS !`. */
const MAX_SIZE_MULTIPLIER = 8;

/** Highest permitted feed distance, imposed by ESC/POS `ESC d`. */
const MAX_FEED_LINES = 255;

/** Dots per QR module when `<qr>` carries no argument. Legible on 58mm paper without dominating it. */
const DEFAULT_QR_MODULE_SIZE = 6;

/** Largest QR module size, imposed by ESC/POS `GS ( k` function 167. */
const MAX_QR_MODULE_SIZE = 16;

/** PDF417 error-correction level when `<pdf417>` carries no argument. */
const DEFAULT_PDF417_ERROR_LEVEL = 1;

/** Highest PDF417 error-correction level, imposed by ESC/POS `GS ( k` function 069. */
const MAX_PDF417_ERROR_LEVEL = 8;

/** Narrowest image this system will print, as a percentage of the paper. */
const MIN_IMAGE_WIDTH_PERCENT = 1;

/** Widest an image may be printed: the whole printable width, which the paper cannot exceed. */
const MAX_IMAGE_WIDTH_PERCENT = 100;

/** A data URI `<image>` accepts: base64 PNG or JPEG. Line breaks are trimmed out before this runs. */
const IMAGE_DATA_URI = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/;

/** What `<chart>` can be drawn as. */
const CHART_KINDS: readonly string[] = ["bar", "line", "pie", "scatter"];

/** The charts that plot points a marker can be drawn on. */
const MARKER_KINDS: readonly string[] = ["line", "scatter"];

/** Fullest a `<bar>` gauge can be asked for, as a percentage. */
const MAX_GAUGE_PERCENT = 100;

/**
 * The tags the printer prints for itself, which is why no block may hold one.
 *
 * A block is a region of dots this side draws and sends as a picture. A symbol is encoded by the
 * printer's own firmware and a cut or a feed acts on the paper rather than marking it, so neither
 * is something that can be drawn into a region: there is nothing to draw.
 */
const PRINTER_DRAWN: ReadonlySet<string> = new Set(["qr", "barcode", "pdf417", "cut", "feed", "drawer"]);

/** The blocks that mean nothing on their own, and the block each belongs directly inside. */
const REQUIRED_PARENT: ReadonlyMap<string, BlockTag> = new Map([
	["row", "table"],
	["cell", "row"],
	["series", "chart"],
	["labels", "chart"],
] as [string, BlockTag][]);

/** The blocks that hold named tags and nothing else, whitespace and line breaks apart. */
const HOLDS_ONLY: ReadonlyMap<BlockTag, readonly string[]> = new Map([
	["table", ["row"]],
	["row", ["cell"]],
	["chart", ["series", "labels"]],
] as [BlockTag, readonly string[]][]);

/** The blocks that may sit beside something else on a line, rather than owning whole lines. */
const SHARES_A_LINE: ReadonlySet<BlockTag> = new Set(["row", "cell", "series", "labels", "bar"]);

type OpenToken = Extract<Token, { kind: "open" }>;

/**
 * What one line of a line-owning scope has seen so far.
 *
 * Every frame inside the scope holds the same object, so a check written against the innermost
 * frame sees what an enclosing one placed. It is reset in place at the end of each line rather
 * than replaced, for the same reason.
 */
interface LineState {
	/**
	 * Anything at all has been placed on this line.
	 *
	 * What decides whether a line-owning tag may still open. A cash drawer pulse counts, although
	 * it prints nothing: `<drawer><align=center>x</align>` is an author asking for alignment around
	 * something that is not the start of the line.
	 */
	content: boolean;
	/** Text has been placed, as opposed to a directive that prints by itself. */
	textSeen: boolean;
	fills: number;
	/** Directives that consume paper. A drawer pulse is not one of them. */
	printing: number;
	/**
	 * An `<align>` has already claimed this line, whether or not it is still open.
	 *
	 * Outlives the tag itself, because a second one written after the first has closed is the same
	 * contradiction as a second one written inside it: the line can only be justified one way.
	 */
	alignSeen: boolean;
	/** A `<wrap>` or `<nowrap>` has already claimed this line. The two share one slot. */
	wrapSeen: boolean;
	/** A rule or a symbol claimed the line; verified when the line ends. */
	soleOccupant: { name: string; line: number; column: number; code: MarkupErrorCode } | null;
	/** A line-owning tag closed; nothing else may follow on this line. */
	closedOwner: { name: string; code: MarkupErrorCode } | null;
	/**
	 * Nothing but whitespace has been placed on this line.
	 *
	 * What lets a block open on a line that is indented. A block is laid out in dots rather than in
	 * columns, so the spaces written around its tags print nothing at all and the line is still the
	 * fresh one the block has to own; the spaces themselves are dropped when the line ends.
	 */
	spaceOnly: boolean;
	/** A block's tag sits on this line, so the whitespace around it prints nothing. */
	blockSeen: boolean;
	/** Text holding only whitespace, and where it was pushed, in case the line turns out to be a block's. */
	spaces: { list: Node[]; node: Node }[];
}

/** What a block is accumulating while it is open. */
interface BlockState {
	/** Cells opened inside this `<table>` so far, charged against the limit. */
	cells: number;
	/** Where a `<series>` inside this `<chart>` asked for a marker, checked when the chart closes. */
	marker: { line: number; column: number } | null;
}

/** A tag that encloses data rather than markup, and the data read so far. */
interface ContentState {
	tag: Tag;
	/** One entry per text token. Line breaks contribute nothing, so they add no entry. */
	parts: string[];
	/**
	 * What the tag's argument said the content will become, resolved when the tag opened.
	 *
	 * Null for a block that encloses data: its numbers are read against the chart that holds them,
	 * which is a measurement rather than a shape, so nothing about them is settled here.
	 */
	shape: ContentShape | null;
}

/** A content tag's argument, resolved before its content is known. */
type ContentShape =
	| { kind: "QR"; size: number }
	| { kind: "BARCODE"; system: BarcodeSystem }
	| { kind: "PDF417"; errorLevel: number }
	| { kind: "IMAGE"; widthPercent: number | null };

/**
 * A tag that is open, and where the nodes inside it go.
 *
 * The root frame stands for the document itself: it has no tag and cannot be closed, which is what
 * makes a stray `</bold>` a refusal rather than an empty stack.
 */
interface Frame {
	tag: Tag | null;
	node: ScopeNode | AlignNode | WrapNode | BlockNode | null;
	children: Node[];
	line: number;
	column: number;
	/** The line state of the nearest scope that owns lines: a block, or the document. */
	owner: LineState;
	/** What this block is accumulating, on a block's frame; null on every other. */
	block: BlockState | null;
	content: ContentState | null;
}

/**
 * Builds the tree for one document.
 *
 * @param tokenized the document's tokens and line lengths
 * @param options the limits this document is parsed under
 * @returns the tree, with every shape rule already satisfied
 * @throws MarkupError if the document is malformed, carrying the line and column at fault
 */
export function buildDocument(tokenized: Tokenized, options: ParseOptions): Document {
	return new DocumentBuilder(tokenized, options).build();
}

/**
 * One document's build.
 *
 * A stack machine, and a class because that stack is genuinely the state: naming the frames and
 * the per-line bookkeeping is what makes rules like "an alignment owns its whole line" readable
 * instead of implicit in a tangle of flags.
 */
class DocumentBuilder {
	private readonly frames: Frame[] = [];
	private readonly lines: LineInfo[];

	constructor(
		private readonly tokenized: Tokenized,
		private readonly options: ParseOptions,
	) {
		this.lines = tokenized.lineChars.map((chars, index) => ({ number: index + 1, chars, interior: false }));
		this.frames.push({
			tag: null,
			node: null,
			children: [],
			line: 1,
			column: 1,
			owner: freshLine(),
			block: null,
			content: null,
		});
	}

	build(): Document {
		for (const token of this.tokenized.tokens) {
			switch (token.kind) {
				case "text":
					this.readText(token);
					break;
				case "break":
					this.readBreak(token);
					break;
				case "open":
					this.openTag(token);
					break;
				case "close":
					this.closeTag(token);
					break;
			}
		}

		const innermost = this.frame();
		if (innermost.tag) {
			throw new MarkupError(
				MARKUP_ERRORS.unclosedTag,
				innermost.line,
				innermost.column,
				innermost.tag.name,
				`Tag <${innermost.tag.name}> was never closed`,
			);
		}
		this.endLine();

		return { nodes: this.frames[0].children, lines: this.lines };
	}

	// -----------------------------------------------------------------------
	// Text and lines
	// -----------------------------------------------------------------------

	private readText(token: Extract<Token, { kind: "text" }>): void {
		const frame = this.frame();
		const blank = token.text.trim().length === 0;
		// A block draws its whole line as a picture, so whitespace around its tags is markup rather
		// than content on that line — the same reasoning that already drops it before the opener.
		// Blank text after the closer gets the same pass here, rather than being caught by the
		// closed-owner check meant for real content written beside a block.
		if (!(blank && frame.owner.blockSeen)) {
			this.requireInsideLineScope(token.line, token.column);
		}

		if (frame.content) {
			frame.content.parts.push(token.text);
			return;
		}

		if (!blank) {
			this.requireTextIsWelcome(token.line, token.column);
		}

		const node: Node = {
			kind: "text",
			text: token.text,
			line: token.line,
			column: token.column,
			...(token.expandedFrom === undefined ? {} : { expandedFrom: token.expandedFrom }),
		};
		frame.children.push(node);
		frame.owner.content = true;
		frame.owner.textSeen = true;
		if (blank) {
			frame.owner.spaces.push({ list: frame.children, node });
			return;
		}
		frame.owner.spaceOnly = false;
	}

	/**
	 * Rejects text written straight into a block that holds tags rather than words.
	 *
	 * A table holds rows and a chart holds series; text between them belongs to no cell and no
	 * plot, so there is nowhere on the paper for it to go. Whitespace is the exception, because
	 * indenting the markup is not writing text.
	 */
	private requireTextIsWelcome(line: number, column: number): void {
		const block = this.enclosingBlock();
		const holds = block ? HOLDS_ONLY.get(block.tag) : undefined;
		if (block && holds) {
			throw new MarkupError(
				MARKUP_ERRORS.misplacedBlock,
				line,
				column,
				block.tag,
				`<${block.tag}> holds ${listed(holds)} rather than text`,
			);
		}
	}

	/**
	 * Ends one printed line.
	 *
	 * Inside a content tag there is no printed line to end: the break is whitespace between parts
	 * of a payload, so it neither becomes a node nor resets anything. The lines it crosses are
	 * marked as swallowed when the tag closes.
	 */
	private readBreak(token: Extract<Token, { kind: "break" }>): void {
		const frame = this.frame();
		if (frame.content) {
			return;
		}
		this.endLine();
		frame.children.push({ kind: "break", line: token.line, column: token.column });
	}

	/** Ends the line of the scope this position is written in. */
	private endLine(): void {
		this.endLineOf(this.frame().owner);
	}

	/**
	 * Verifies what a finished line holds, then clears it for the next one.
	 *
	 * A rule expands to the full paper width and a symbol is a block of dots several lines tall, so
	 * either combined with anything else would overflow its line by construction rather than by
	 * accident. `<drawer>` is exempt because it prints nothing at all: it pulses a
	 * solenoid, so it costs the line no paper and may legally sit beside anything. Fills count even
	 * though they produce no text yet — `<hr><fill=.>` would otherwise print a line of dots, feed,
	 * and then the rule.
	 *
	 * The state is an argument rather than the innermost frame's, because a block's last line ends
	 * when the block closes: by then the frame that owned that line has been popped, and the line
	 * still has to be checked.
	 */
	private endLineOf(state: LineState): void {
		const occupant = state.soleOccupant;
		if (occupant && (state.textSeen || state.fills > 0 || state.printing !== 1)) {
			throw new MarkupError(
				occupant.code,
				occupant.line,
				occupant.column,
				occupant.name,
				`<${occupant.name}> takes a whole line and must be alone on its line`,
			);
		}

		// A line whose only tags are a block's prints no text of its own: the region is drawn in dots
		// and the spaces written around its tags are markup rather than paper. Dropped now rather than
		// when they were read, because nothing knew then what else the line would hold.
		if (state.blockSeen) {
			for (const space of state.spaces) {
				const at = space.list.indexOf(space.node);
				if (at >= 0) {
					space.list.splice(at, 1);
				}
			}
		}

		state.content = false;
		state.textSeen = false;
		state.fills = 0;
		state.printing = 0;
		state.alignSeen = false;
		state.wrapSeen = false;
		state.soleOccupant = null;
		state.closedOwner = null;
		state.spaceOnly = true;
		state.blockSeen = false;
		state.spaces.length = 0;
	}

	// -----------------------------------------------------------------------
	// Opening tags
	// -----------------------------------------------------------------------

	private openTag(token: OpenToken): void {
		const tag = tagByName(token.name);
		if (!tag) {
			throw new MarkupError(
				MARKUP_ERRORS.unknownTag,
				token.line,
				token.column,
				token.name,
				`Unknown tag '${token.name}'; write &lt; for a literal '<'`,
			);
		}

		const frame = this.frame();
		if (frame.content) {
			this.refuseInsideContent(frame.content.tag, tag, token.line, token.column);
		}

		this.requireArgumentPolicy(tag, token.argument, token.line, token.column);
		const attributes = readAttributes(tag.name, token.attributes, tag.attributes, token.line);
		this.requirePlacement(tag, token.line, token.column);

		if (isBlockTag(tag.name)) {
			this.openContent(tag, token);
			return;
		}

		switch (tag.name) {
			case "box":
			case "table":
			case "row":
			case "cell":
			case "chart":
				this.openRegion(tag, token, attributes);
				return;
			case "series":
			case "labels":
				this.openDataBlock(tag, token, attributes);
				return;
			case "bar":
				this.appendGauge(tag, token, attributes);
				return;
			case "bold":
			case "underline":
			case "invert":
			case "size":
			case "font":
				this.openScope(tag, tag.name, token, attributes);
				return;
			case "align":
				this.openAlign(token);
				return;
			case "wrap":
			case "nowrap":
				this.openWrap(tag, token);
				return;
			case "fill":
				this.appendFill(token);
				return;
			case "hr":
				this.appendRule(token);
				return;
			case "cut":
			case "feed":
			case "drawer":
				this.appendVoid(tag, token);
				return;
			default:
				throw new Error(`Tag ${tag.name} has no place in a document`);
		}
	}

	private openScope(tag: Tag, scope: ScopeTag, token: OpenToken, attributes: Attributes): void {
		this.requireInsideLineScope(token.line, token.column);
		this.enter(tag, token, {
			kind: "scope",
			tag: scope,
			patch: this.stylePatch(tag, scope, token.argument, token.line, token.column, attributes, token.attributes),
			line: token.line,
			column: token.column,
			children: [],
		});
	}

	/**
	 * The change one styling tag makes, rather than the style that results.
	 *
	 * @throws MarkupError if the argument is malformed or out of range
	 */
	private stylePatch(
		tag: Tag,
		scope: ScopeTag,
		argument: string | null,
		line: number,
		column: number,
		attributes: Attributes,
		rawAttributes: readonly RawAttribute[],
	): Partial<SpanStyle> {
		switch (scope) {
			case "bold":
				return { bold: true };
			case "invert":
				return { invert: true };
			case "underline": {
				const thickness = argument === null ? 1 : this.requireInt(argument, 1, 2, tag, line, column);
				return { underline: thickness as 0 | 1 | 2 };
			}
			case "size": {
				const parts = (argument as string).split(",");
				if (parts.length > 2) {
					throw this.argumentError(TAGS.size, line, column, "expected W or W,H");
				}
				const width = this.requireInt(parts[0], 1, MAX_SIZE_MULTIPLIER, TAGS.size, line, column);
				const height =
					parts.length === 1 ? width : this.requireInt(parts[1], 1, MAX_SIZE_MULTIPLIER, TAGS.size, line, column);
				return { widthMult: width, heightMult: height };
			}
			case "font": {
				const raw = argument ?? "";
				const builtIn = raw.toUpperCase();
				const sizeAttribute = rawAttributes.find((attribute) => attribute.name === "size");

				if (Font.is(builtIn)) {
					if (sizeAttribute) {
						throw new MarkupError(
							MARKUP_ERRORS.invalidAttribute,
							line,
							sizeAttribute.column,
							"size",
							"<font> size applies to a configured font, not to the printer's own",
						);
					}
					return { font: builtIn, face: null, faceDots: 24 };
				}

				if (!NAME_PATTERN.test(raw)) {
					throw this.argumentError(tag, line, column, `'${raw}' is not a built-in font or a font name`);
				}

				const size = attributes.size as number | undefined;
				if (size !== undefined && size > this.options.maxFontHeight) {
					throw new MarkupError(
						MARKUP_ERRORS.invalidAttribute,
						line,
						sizeAttribute?.column ?? column,
						"size",
						`<font> size must be at most ${this.options.maxFontHeight}`,
					);
				}
				return { face: raw, faceDots: size ?? 24 };
			}
		}
	}

	private openAlign(token: OpenToken): void {
		const state = this.frame().owner;
		if (state.alignSeen || this.lineOwnerOpen("align")) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidAlignScope,
				token.line,
				token.column,
				"align",
				"Only one <align> is allowed per line",
			);
		}
		this.requireLineOwnerCanOpen("align", MARKUP_ERRORS.invalidAlignScope, token.line, token.column);

		const value = (token.argument ?? "").toUpperCase();
		if (!Align.is(value)) {
			throw this.argumentError(TAGS.align, token.line, token.column, "must be 'left', 'center' or 'right'");
		}

		state.alignSeen = true;
		this.enter(TAGS.align, token, {
			kind: "align",
			align: value,
			line: token.line,
			column: token.column,
			children: [],
		});
	}

	/**
	 * Opens `<wrap>` or `<nowrap>`.
	 *
	 * Both occupy one slot: a line either wraps or it does not, so writing both is a contradiction
	 * rather than a refinement. The refusal names the tag being opened, which is the one the author
	 * has to delete.
	 */
	private openWrap(tag: Tag, token: OpenToken): void {
		const state = this.frame().owner;
		if (state.wrapSeen || this.lineOwnerOpen("wrap")) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidWrapScope,
				token.line,
				token.column,
				tag.name,
				"Only one <wrap> or <nowrap> is allowed per line",
			);
		}
		this.requireLineOwnerCanOpen(tag.name, MARKUP_ERRORS.invalidWrapScope, token.line, token.column);

		state.wrapSeen = true;
		this.enter(tag, token, {
			kind: "wrap",
			wrap: tag.name === "wrap",
			line: token.line,
			column: token.column,
			children: [],
		});
	}

	/**
	 * Opens a tag that encloses data rather than markup.
	 *
	 * The argument is resolved here rather than when the tag closes, so a bad one is refused at the
	 * position it was written and before the rest of the document has been read. The content cannot
	 * be judged until it is complete, so it waits; the argument has no reason to.
	 */
	private openContent(tag: Tag, token: OpenToken): void {
		this.requireInsideLineScope(token.line, token.column);

		const shape = this.contentShape(tag, token.argument, token.line, token.column);
		this.enter(tag, token, null).content = { tag, parts: [], shape };

		// A symbol is a block of dots the printer places by itself, so it claims the printed line it
		// is placed on. An image claims nothing: it is the one of these the layout engine can place
		// beside text, in a row of glyphs sized to its own dots, and a line holding one is drawn into
		// a raster rather than sent as columns.
		if (tag !== TAGS.image) {
			this.claimLine(tag.name, token.line, token.column, MARKUP_ERRORS.invalidBlockScope);
		}
	}

	/**
	 * Reads a content tag's argument.
	 *
	 * @throws MarkupError if it is not a module size, error level, symbology or width this tag takes
	 */
	private contentShape(tag: Tag, argument: string | null, line: number, column: number): ContentShape {
		switch (tag.name) {
			case "qr":
				return {
					kind: "QR",
					size:
						argument === null
							? DEFAULT_QR_MODULE_SIZE
							: this.requireInt(argument, 1, MAX_QR_MODULE_SIZE, tag, line, column),
				};
			case "pdf417":
				return {
					kind: "PDF417",
					errorLevel:
						argument === null
							? DEFAULT_PDF417_ERROR_LEVEL
							: this.requireInt(argument, 0, MAX_PDF417_ERROR_LEVEL, tag, line, column),
				};
			case "barcode": {
				const system = (argument ?? "").toUpperCase();
				if (!BarcodeSystem.is(system)) {
					throw this.argumentError(tag, line, column, `must name a symbology: ${BarcodeSystem.values.join(", ")}`);
				}
				return { kind: "BARCODE", system };
			}
			case "image":
				return {
					kind: "IMAGE",
					widthPercent:
						argument === null
							? null
							: this.requireInt(argument, MIN_IMAGE_WIDTH_PERCENT, MAX_IMAGE_WIDTH_PERCENT, tag, line, column),
				};
			default:
				throw new Error(`Tag ${tag.name} encloses markup rather than data`);
		}
	}

	private appendFill(token: OpenToken): void {
		this.requireInsideLineScope(token.line, token.column);

		const character = token.argument ?? " ";
		// Code points, not UTF-16 units: an astral character is one character and two units, and
		// measuring units would refuse a legitimate single character as though it were two.
		if ([...character].length !== 1) {
			throw this.argumentError(TAGS.fill, token.line, token.column, "takes a single character, written <fill=x>");
		}

		const frame = this.frame();
		frame.children.push({ kind: "fill", character, line: token.line, column: token.column });
		frame.owner.fills += 1;
		this.placed(frame.owner);
	}

	private appendRule(token: OpenToken): void {
		this.requireInsideLineScope(token.line, token.column);

		const frame = this.frame();
		frame.children.push({ kind: "rule", line: token.line, column: token.column });
		this.claimLine("hr", token.line, token.column, MARKUP_ERRORS.invalidRuleScope);
		frame.owner.printing += 1;
		this.placed(frame.owner);
	}

	private appendVoid(tag: Tag, token: OpenToken): void {
		this.requireInsideLineScope(token.line, token.column);

		const directive = this.voidDirective(tag, token.argument, token.line, token.column);
		const frame = this.frame();
		frame.children.push({ kind: "void", directive, line: token.line, column: token.column });
		this.placed(frame.owner);
		if (directive.kind !== "DRAWER") {
			frame.owner.printing += 1;
		}
	}

	private voidDirective(tag: Tag, argument: string | null, line: number, column: number): VoidDirective {
		switch (tag.name) {
			case "cut":
				return { kind: "CUT", mode: this.cutMode(argument, line, column) };
			case "feed":
				return { kind: "FEED", lines: this.requireInt(argument as string, 1, MAX_FEED_LINES, tag, line, column) };
			case "drawer":
				return { kind: "DRAWER", pin: this.drawerPin(argument, line, column) };
			default:
				throw new Error(`Tag ${tag.name} is not a directive`);
		}
	}

	private cutMode(argument: string | null, line: number, column: number): "FULL" | "PARTIAL" {
		if (argument === null || argument.toLowerCase() === "full") {
			return "FULL";
		}
		if (argument.toLowerCase() === "partial") {
			return "PARTIAL";
		}
		throw this.argumentError(TAGS.cut, line, column, "must be 'full' or 'partial'");
	}

	private drawerPin(argument: string | null, line: number, column: number): 2 | 5 {
		if (argument === null || argument === "2") {
			return 2;
		}
		if (argument === "5") {
			return 5;
		}
		throw this.argumentError(TAGS.drawer, line, column, "must be pin 2 or 5");
	}

	// -----------------------------------------------------------------------
	// Blocks
	// -----------------------------------------------------------------------

	/**
	 * Rejects a tag written where the block around it does not admit it.
	 *
	 * The shape of a region is checked here and only here, which is what lets the layout engine
	 * descend a table without asking at every step whether the thing it has reached is a row. A
	 * refusal names both tags, because which of the two the author has to move is not obvious from
	 * either alone.
	 *
	 * @throws MarkupError if this tag cannot sit inside the block that encloses it
	 */
	private requirePlacement(tag: Tag, line: number, column: number): void {
		const inside = this.enclosingBlock()?.tag ?? null;
		const refuse = (message: string): never => {
			throw new MarkupError(MARKUP_ERRORS.misplacedBlock, line, column, tag.name, message);
		};

		if (inside !== null && PRINTER_DRAWN.has(tag.name)) {
			refuse(`<${tag.name}> is printed by the printer itself, so it cannot sit inside <${inside}>`);
		}

		const required = REQUIRED_PARENT.get(tag.name);
		if (required !== undefined && inside !== required) {
			refuse(`<${tag.name}> belongs directly inside <${required}>`);
		}

		const holds = inside === null ? undefined : HOLDS_ONLY.get(inside);
		if (holds && !holds.includes(tag.name)) {
			refuse(`<${inside}> holds ${listed(holds)} and nothing else`);
		}
	}

	/**
	 * Opens a block that encloses markup.
	 *
	 * `box`, `table` and `chart` own whole lines for the same reason `<align>` does: each is drawn
	 * as a region the width of the paper offers it, so text beside one would have nowhere to go.
	 * `row` and `cell` are the parts of a region rather than regions themselves, so they may be
	 * written along one line — which is how a table is readable in source at all.
	 */
	private openRegion(tag: Tag, token: OpenToken, attributes: Attributes): void {
		const block = tag.name as BlockTag;
		const argument = this.blockArgument(tag, token, attributes);

		if (SHARES_A_LINE.has(block)) {
			this.requireInsideLineScope(token.line, token.column);
		} else {
			this.requireBlockCanOpen(tag.name, token.line, token.column);
		}
		if (block === "cell") {
			this.countCell(token.line, token.column);
		}
		this.enterBlock(token.line, token.column);

		this.enter(tag, token, {
			kind: "block",
			tag: block,
			argument,
			attributes,
			content: null,
			children: [],
			line: token.line,
			column: token.column,
		});
	}

	/**
	 * Opens a block that encloses data: a series' values, or a chart's labels.
	 *
	 * Kept verbatim rather than read into numbers here, because what the numbers have to be is a
	 * property of the chart that plots them — how many a series may hold, how many labels the
	 * categories leave room for — and the chart is not finished being read yet.
	 */
	private openDataBlock(tag: Tag, token: OpenToken, attributes: Attributes): void {
		this.requireInsideLineScope(token.line, token.column);
		this.rememberMarker(token, attributes);
		this.enterBlock(token.line, token.column);

		this.enter(tag, token, {
			kind: "block",
			tag: tag.name as BlockTag,
			argument: token.argument,
			attributes,
			content: null,
			children: [],
			line: token.line,
			column: token.column,
		}).content = { tag, parts: [], shape: null };
	}

	/** Appends a gauge, which encloses nothing: how full it is drawn is its argument. */
	private appendGauge(tag: Tag, token: OpenToken, attributes: Attributes): void {
		this.requireInsideLineScope(token.line, token.column);
		this.enterBlock(token.line, token.column);

		const frame = this.frame();
		frame.children.push({
			kind: "block",
			tag: "bar",
			argument: this.blockArgument(tag, token, attributes),
			attributes,
			content: null,
			children: [],
			line: token.line,
			column: token.column,
		});
		this.placeBlock(frame.owner, "bar");
	}

	/**
	 * Reads a block's argument into the form the layout engine will draw it from.
	 *
	 * @throws MarkupError if the argument names no chart this draws, or is not a percentage
	 */
	private blockArgument(tag: Tag, token: OpenToken, attributes: Attributes): string | null {
		switch (tag.name) {
			case "chart": {
				// Lowercased, so the layout engine matches against one spelling however the tag was
				// written, which is the same courtesy `<align>` and `<barcode>` extend by upper-casing.
				const kind = (token.argument ?? "").toLowerCase();
				if (!CHART_KINDS.includes(kind)) {
					throw this.argumentError(tag, token.line, token.column, `must name a chart: ${CHART_KINDS.join(", ")}`);
				}
				if (attributes.area !== undefined && kind !== "line") {
					throw new MarkupError(
						MARKUP_ERRORS.invalidAttribute,
						token.line,
						attributeColumn(token, "area"),
						"area",
						"<chart> area fills under a line, so it applies to a line chart only",
					);
				}
				return kind;
			}
			case "bar":
				this.requireInt(token.argument as string, 0, MAX_GAUGE_PERCENT, tag, token.line, token.column);
				return token.argument;
			default:
				return token.argument;
		}
	}

	/** Records where a `<series>` asked for a marker, which the chart it sits in has the final say on. */
	private rememberMarker(token: OpenToken, attributes: Attributes): void {
		const chart = this.frame().block;
		if (chart && attributes.marker !== undefined) {
			chart.marker ??= { line: token.line, column: attributeColumn(token, "marker") };
		}
	}

	/**
	 * Charges one cell against the table that holds it.
	 *
	 * Counted per table rather than per document, because the cost the limit bounds is the layout: a
	 * table measures every cell against every other one in its column, so it is one table growing
	 * that is expensive rather than a receipt holding several small ones.
	 *
	 * @throws MarkupError if this table holds more cells than the limit allows
	 */
	private countCell(line: number, column: number): void {
		for (let at = this.frames.length - 1; at > 0; at--) {
			const frame = this.frames[at];
			if (frame.node?.kind !== "block" || frame.node.tag !== "table" || !frame.block) {
				continue;
			}
			frame.block.cells += 1;
			if (frame.block.cells > this.options.maxTableCells) {
				throw new MarkupError(
					MARKUP_ERRORS.tooManyCells,
					line,
					column,
					String(frame.block.cells),
					`A table may hold at most ${this.options.maxTableCells} cells`,
				);
			}
			return;
		}
	}

	/**
	 * Rejects a block that cannot own the line it was opened on.
	 *
	 * The same rule `<align>` follows, and for a stronger reason: an alignment still prints the
	 * line's own text, while a block replaces the line with a picture of itself.
	 */
	private requireBlockCanOpen(name: string, line: number, column: number): void {
		this.requireInsideLineScope(line, column);
		if (!this.frame().owner.spaceOnly || this.insideStyling()) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidBlockScope,
				line,
				column,
				name,
				`<${name}> must enclose whole lines, so nothing may precede it`,
			);
		}
	}

	/**
	 * Records a finished block on the line that holds it.
	 *
	 * A block prints, so it costs the line paper the way a symbol does. The blocks that own their
	 * lines close them too: what follows one on its line would be text beside a drawn region, which
	 * is the same contradiction as text after `</align>`.
	 */
	private placeBlock(state: LineState, tag: BlockTag): void {
		this.placed(state);
		state.blockSeen = true;
		state.printing += 1;
		if (!SHARES_A_LINE.has(tag)) {
			state.closedOwner = { name: tag, code: MARKUP_ERRORS.invalidBlockScope };
		}
	}

	/**
	 * Closes a block that encloses markup: its last line is verified, and the chart it may be is
	 * checked against the series it turned out to hold.
	 *
	 * @throws MarkupError if that last line is malformed, or a marker was asked for on a chart that
	 * plots no points
	 */
	private closeRegion(frame: Frame, node: BlockNode): void {
		frame.owner.blockSeen = true;
		this.endLineOf(frame.owner);

		const marker = node.tag === "chart" ? frame.block?.marker : null;
		if (marker && !MARKER_KINDS.includes(node.argument ?? "")) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidAttribute,
				marker.line,
				marker.column,
				"marker",
				`<series> marker draws on plotted points, so it applies to ${MARKER_KINDS.join(" and ")} charts only`,
			);
		}

		this.placeBlock(this.frame().owner, node.tag);
	}

	// -----------------------------------------------------------------------
	// Closing tags
	// -----------------------------------------------------------------------

	private closeTag(token: Extract<Token, { kind: "close" }>): void {
		const tag = tagByName(token.name);
		if (!tag) {
			throw new MarkupError(
				MARKUP_ERRORS.unknownTag,
				token.line,
				token.column,
				token.name,
				`Unknown tag '${token.name}'`,
			);
		}

		const frame = this.frame();
		if (frame.content && frame.content.tag !== tag) {
			this.refuseInsideContent(frame.content.tag, tag, token.line, token.column);
		}

		if (tag.kind === "VOID") {
			throw new MarkupError(
				MARKUP_ERRORS.unexpectedCloseTag,
				token.line,
				token.column,
				tag.name,
				`<${tag.name}> stands alone and cannot be closed`,
			);
		}

		if (frame.content) {
			this.closeContent(frame, frame.content, token.line);
			return;
		}

		if (frame.tag !== tag) {
			const expected = frame.tag ? `expected </${frame.tag.name}>` : "no tag is open";
			throw new MarkupError(
				MARKUP_ERRORS.unexpectedCloseTag,
				token.line,
				token.column,
				tag.name,
				`</${tag.name}> does not match: ${expected}`,
			);
		}

		this.frames.pop();
		const node = frame.node;
		if (node) {
			if (node.kind === "block") {
				this.closeRegion(frame, node);
			}
			this.frame().children.push(node);
			if (node.kind === "align" || node.kind === "wrap") {
				this.releaseLineOwner(tag, node.kind);
			}
		}
	}

	/**
	 * Records that a line-owning tag has closed.
	 *
	 * Alignment and wrapping both apply to a whole printed line, so anything after one closes would
	 * silently inherit a property the author did not write on it. Remembering which tag closed is
	 * what lets that refusal name the right one.
	 *
	 * The line's claim is not released with it: `<wrap>a</wrap><nowrap>b</nowrap>` is refused as a
	 * second wrap rather than as content after a closed one, because a second one is what the author
	 * wrote. The claim lifts when the line ends.
	 */
	private releaseLineOwner(tag: Tag, kind: "align" | "wrap"): void {
		this.frame().owner.closedOwner = {
			name: tag.name,
			code: kind === "align" ? MARKUP_ERRORS.invalidAlignScope : MARKUP_ERRORS.invalidWrapScope,
		};
	}

	/**
	 * Closes a tag that encloses data, turning what it captured into a node.
	 *
	 * Validation happens here, where the whole payload is finally known, and reports the opening
	 * tag's position: the content runs to the end of the tag, so the tag that says how it will be
	 * encoded is the more useful thing to point a caller at.
	 *
	 * @throws MarkupError if the symbology cannot encode this content, or an image names nothing
	 */
	private closeContent(frame: Frame, content: ContentState, closeLine: number): void {
		this.frames.pop();

		// Line breaks are whitespace around the payload rather than part of it, so they contribute
		// nothing and the ends are trimmed. Spaces inside it are left alone: they are as much part of
		// a URL or an article number as any other character.
		const data = content.parts.join("").trim();
		const parent = this.frame();
		const block = frame.node;

		if (block?.kind === "block") {
			block.content = data;
			parent.children.push(block);
			this.placeBlock(parent.owner, block.tag);
		} else {
			parent.children.push(this.contentNode(frame, content, data));
			parent.owner.printing += 1;
			this.placed(parent.owner);
		}

		for (let number = frame.line + 1; number < closeLine; number++) {
			this.lines[number - 1].interior = true;
		}
	}

	private contentNode(frame: Frame, content: ContentState, data: string): SymbolNode | ImageNode {
		const shape = content.shape;
		if (!shape) {
			// A shape is resolved for every tag that becomes a symbol or an image; the ones with none
			// become a block instead, and never reach here.
			throw new Error(`Tag ${content.tag.name} encloses data that a block keeps rather than a symbol`);
		}

		if (shape.kind === "IMAGE") {
			if (data.length === 0) {
				throw new MarkupError(
					MARKUP_ERRORS.invalidTagArgument,
					frame.line,
					frame.column,
					content.tag.name,
					"<image> must enclose a stored image's name or an http(s) URL",
				);
			}
			return {
				kind: "image",
				ref: data,
				source: this.imageSource(data, frame),
				widthPercent: shape.widthPercent,
				line: frame.line,
				column: frame.column,
			};
		}

		const spec: SymbolSpec =
			shape.kind === "QR"
				? { kind: "QR", content: data, size: shape.size }
				: shape.kind === "BARCODE"
					? { kind: "BARCODE", content: data, system: shape.system }
					: { kind: "PDF417", content: data, errorLevel: shape.errorLevel };

		const refusal = validateSymbolContent(spec);
		if (refusal) {
			throw new MarkupError(MARKUP_ERRORS.invalidTagArgument, frame.line, frame.column, content.tag.name, refusal);
		}
		return { kind: "symbol", spec, line: frame.line, column: frame.column };
	}

	/**
	 * Reads an `<image>`'s content into where its dots come from.
	 *
	 * A `data:` prefix is the only thing that distinguishes an inline data URI from a stored name or
	 * an `http(s)` URL: both of those are opaque strings to the tree either way, resolved by a later
	 * stage that has a database and a network to reach with. A data URI is not opaque — its bytes are
	 * already sitting in the document — so this is the one shape checked now rather than later.
	 *
	 * @throws MarkupError if a `data:` prefix is not followed by a base64 PNG or JPEG payload
	 */
	private imageSource(data: string, frame: Frame): ImageSourceRef {
		if (!data.startsWith("data:")) {
			return { kind: "named", name: data };
		}

		const match = IMAGE_DATA_URI.exec(data);
		const bytes = match ? Buffer.from(match[2], "base64") : null;
		// Re-encoding is what makes the decode trustworthy: `Buffer.from` silently skips characters it
		// does not recognise, so text that does not come back unchanged was not base64 to begin with.
		if (!match || !bytes || bytes.toString("base64") !== match[2]) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidImageData,
				frame.line,
				frame.column,
				"image",
				"<image> data must be a base64 PNG or JPEG data URI",
			);
		}

		return { kind: "data", mimeType: match[1] as "image/png" | "image/jpeg", bytes };
	}

	// -----------------------------------------------------------------------
	// Shared checks
	// -----------------------------------------------------------------------

	/** Rejects anything written after a line-owning tag has closed on this line. */
	private requireInsideLineScope(line: number, column: number): void {
		const closed = this.frame().owner.closedOwner;
		if (closed) {
			throw new MarkupError(
				closed.code,
				line,
				column,
				closed.name,
				`<${closed.name}> must enclose the whole line, so nothing may follow </${closed.name}>`,
			);
		}
	}

	/**
	 * Rejects a line-owning tag that cannot legally open here.
	 *
	 * Another line-owning tag may already enclose it — that is the nesting the language allows, in
	 * either order — but anything already placed on the line means the tag does not own it. So does
	 * opening inside a styling tag: styling places nothing of its own until it closes, so without
	 * this check `<bold><nowrap>` would slip past undetected.
	 */
	private requireLineOwnerCanOpen(name: string, code: MarkupErrorCode, line: number, column: number): void {
		this.requireInsideLineScope(line, column);
		if (this.frame().owner.content || this.insideStyling()) {
			throw new MarkupError(
				code,
				line,
				column,
				name,
				`<${name}> must enclose the whole line, so nothing may precede it`,
			);
		}
	}

	/** Records a node that must be the only thing printed on its line. */
	private claimLine(name: string, line: number, column: number, code: MarkupErrorCode): void {
		// The first claim rather than the last, matching the habit of naming the earliest problem in
		// the document. The code travels with it because a rule and a symbol report different ones,
		// both of which are frozen parts of the API contract.
		this.frame().owner.soleOccupant ??= { name, line, column, code };
	}

	/**
	 * Rejects a tag written inside one that encloses data.
	 *
	 * Such a tag encloses the payload of a symbology — a URL, an article number — not markup, so a
	 * tag nested in one would have no effect on what is printed. Refusing says so, rather than
	 * discarding it silently.
	 */
	private refuseInsideContent(outer: Tag, tag: Tag, line: number, column: number): never {
		throw new MarkupError(
			MARKUP_ERRORS.invalidBlockScope,
			line,
			column,
			tag.name,
			`<${outer.name}> encloses data rather than markup, so <${tag.name}> cannot appear inside it`,
		);
	}

	private requireArgumentPolicy(tag: Tag, argument: string | null, line: number, column: number): void {
		const supplied = argument !== null;
		if (supplied && tag.argument === "NONE") {
			throw this.argumentError(tag, line, column, "takes no argument");
		}
		if (!supplied && tag.argument === "REQUIRED") {
			throw this.argumentError(tag, line, column, `requires an argument, written <${tag.name}=value>`);
		}
		if (supplied && argument.length === 0) {
			throw this.argumentError(tag, line, column, "has an empty argument");
		}
	}

	private requireInt(value: string, min: number, max: number, tag: Tag, line: number, column: number): number {
		const trimmed = value.trim();
		// Checked with a pattern rather than by parsing, because parseInt("3px") is 3 and Number(" ")
		// is 0 — both would accept an argument the reference parser refuses.
		if (!/^[+-]?\d+$/.test(trimmed)) {
			throw this.argumentError(tag, line, column, `'${value}' is not a number`);
		}
		const parsed = Number.parseInt(trimmed, 10);
		if (parsed < min || parsed > max) {
			throw this.argumentError(tag, line, column, `must be between ${min} and ${max}, got ${parsed}`);
		}
		return parsed;
	}

	private argumentError(tag: Tag, line: number, column: number, detail: string): MarkupError {
		return new MarkupError(MARKUP_ERRORS.invalidTagArgument, line, column, tag.name, `<${tag.name}> ${detail}`);
	}

	// -----------------------------------------------------------------------
	// Frames
	// -----------------------------------------------------------------------

	private frame(): Frame {
		return this.frames[this.frames.length - 1];
	}

	/**
	 * The block this position is written directly inside, or null at the document's own level.
	 *
	 * Nearest rather than outermost: a block lays out a region of the paper, so what a tag may be is
	 * decided by the region immediately around it — a `<cell>` is welcome in a row and nowhere else,
	 * whatever the row itself sits in. Nothing but a block interrupts the walk, because a styling tag
	 * or an alignment inside one is transparent to this: it places nothing of its own.
	 */
	private enclosingBlock(): BlockNode | null {
		for (let at = this.frames.length - 1; at > 0; at--) {
			const node = this.frames[at].node;
			if (node?.kind === "block") {
				return node;
			}
		}
		return null;
	}

	/** Records that something was placed on the line, so it is no longer the fresh one a block owns. */
	private placed(state: LineState): void {
		state.content = true;
		state.spaceOnly = false;
	}

	/**
	 * Whether a line-owning tag of this kind is still open within the scope that owns the line.
	 *
	 * Read from the frames rather than from a flag, so it falls away when the tag closes without
	 * anything having to remember to say so. It is the other half of the claim {@link LineState}
	 * keeps: this one catches a second tag nested in the first, which may be on a later line.
	 */
	private lineOwnerOpen(kind: "align" | "wrap"): boolean {
		for (let at = this.frames.length - 1; at > 0; at--) {
			const node = this.frames[at].node;
			if (node?.kind === "block") {
				return false;
			}
			if (node?.kind === kind) {
				return true;
			}
		}
		return false;
	}

	/** Whether a styling tag encloses this position within the scope that owns the line. */
	private insideStyling(): boolean {
		for (let at = this.frames.length - 1; at > 0; at--) {
			const kind = this.frames[at].node?.kind;
			if (kind === "block") {
				return false;
			}
			if (kind === "scope") {
				return true;
			}
		}
		return false;
	}

	/**
	 * Pushes the frame for a tag that has just opened.
	 *
	 * A block gets a line state of its own, because its lines are its own: the text in a cell is laid
	 * out against the cell's width and knows nothing of what shares the paper with the table. Every
	 * other tag inherits the state of whatever owns the line it was written on, so that a rule written
	 * inside two styling tags still sees what the line already holds.
	 */
	private enter(tag: Tag, token: OpenToken, node: ScopeNode | AlignNode | WrapNode | BlockNode | null): Frame {
		const parent = this.frame();
		const block = node?.kind === "block";
		const frame: Frame = {
			tag,
			node,
			children: node ? node.children : [],
			line: token.line,
			column: token.column,
			owner: block ? blockLine() : parent.owner,
			block: block ? { cells: 0, marker: null } : null,
			content: null,
		};
		this.frames.push(frame);
		return frame;
	}

	/**
	 * Charges one more level of nesting against the depth limit.
	 *
	 * Blocks are the only nesting that is bounded, because they are the only nesting whose cost is
	 * not linear in the document's length: a table holds rows, a row holds cells, and every level
	 * measures everything below it.
	 *
	 * Counted from the frames rather than kept in a field, so the count falls again when a block
	 * closes without anything having to remember to say so.
	 *
	 * @throws MarkupError if the document nests blocks deeper than the limit allows
	 */
	enterBlock(line: number, column: number): void {
		const depth = this.frames.filter((frame) => frame.node?.kind === "block").length + 1;
		if (depth > this.options.maxBlockDepth) {
			throw new MarkupError(
				MARKUP_ERRORS.nestingTooDeep,
				line,
				column,
				String(depth),
				`Blocks nest ${depth} deep; the limit is ${this.options.maxBlockDepth}`,
			);
		}
	}
}

/** A line with nothing on it yet. */
function freshLine(): LineState {
	return {
		content: false,
		textSeen: false,
		fills: 0,
		printing: 0,
		alignSeen: false,
		wrapSeen: false,
		soleOccupant: null,
		closedOwner: null,
		spaceOnly: true,
		blockSeen: false,
		spaces: [],
	};
}

/** A block's first line, which already carries the block's own opening tag. */
function blockLine(): LineState {
	const line = freshLine();
	line.blockSeen = true;
	return line;
}

/** An attribute's column, for a refusal the tag's own position would point vaguely at. */
function attributeColumn(token: OpenToken, name: string): number {
	return token.attributes.find((attribute) => attribute.name === name)?.column ?? token.column;
}

/** Tag names as a refusal reads them out: `<row>`, or `<series> and <labels>`. */
function listed(names: readonly string[]): string {
	const tags = names.map((name) => `<${name}>`);
	return tags.length < 2 ? tags.join("") : `${tags.slice(0, -1).join(", ")} and ${tags[tags.length - 1]}`;
}
