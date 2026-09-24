import { type Align, type BarcodeSystem, Font } from "@/lib/domain/enums";
import { NAME_PATTERN } from "@/lib/domain/naming";
import { type AppliesWhen, type Attributes, conditionMet, readAttributes } from "@/lib/markup/attributes";
import { type SymbolSpec, validateSymbolContent } from "@/lib/markup/blocks";
import type {
	AlignNode,
	BlockNode,
	BlockTag,
	ChartData,
	ChartType,
	Document,
	ImageNode,
	ImageSourceRef,
	ItemNode,
	LineInfo,
	ListNode,
	ListStyle,
	Node,
	ParseOptions,
	ScopeNode,
	ScopeTag,
	Series,
	SymbolNode,
	VoidDirective,
	WrapNode,
} from "@/lib/markup/document";
import { MARKUP_ERRORS, MarkupError, type MarkupErrorCode } from "@/lib/markup/errors";
import type { SpanStyle } from "@/lib/markup/model";
import {
	HOLDS_ONLY,
	isContentTag,
	NOT_IN_AN_ITEM,
	PRINTER_DRAWN,
	REQUIRED_PARENT,
	TAGS,
	type Tag,
	tagByName,
} from "@/lib/markup/tags";
import type { Token, Tokenized } from "@/lib/markup/tokenizer";

/**
 * Turns a tokenized document into a tree, refusing every shape the language does not allow.
 *
 * **This is the boundary that makes the rest of the system safe.** The tokenizer guarantees that
 * nothing reaches a printer as a command except through a recognised tag; this guarantees that the
 * tag was allowed to be there. Both halves are needed, and keeping them apart is what lets each be
 * read on its own: one is about characters, this is about structure.
 *
 * Every rule is checked exactly once, here. A tag's attributes, whether it may open where it
 * opened, whether it closes what is open, whether a rule shares its line — all of it is settled
 * before a node exists, so nothing downstream has to ask again and nothing downstream can answer
 * differently.
 *
 * What is deliberately *not* checked here is anything that needs a device. How wide the paper is,
 * how many dots a symbol takes, whether an image can be fetched: those are properties of the
 * printer rather than of the markup, and a tree is built the same way wherever markup is parsed.
 */

/** Dots per QR module when `<qr>` carries no `size`. Legible on 58mm paper without dominating it. */
const DEFAULT_QR_MODULE_SIZE = 6;

/** PDF417 error-correction level when `<pdf417>` carries no `level`. */
const DEFAULT_PDF417_ERROR_LEVEL = 1;

/** A data URI `<image>` accepts: base64 PNG or JPEG. Line breaks are trimmed out before this runs. */
const IMAGE_DATA_URI = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/;

/**
 * What a `<series>` marker needs of the chart around it, as the registry states it.
 *
 * Read from the registry rather than repeated here, because the Insert dialog offers the same
 * attribute and would otherwise be free to offer it on a chart this refuses it on. The condition
 * names the *parent's* type, which is why it is checked as the chart closes rather than in
 * {@link readAttributes} with the conditions a tag can settle for itself.
 */
const MARKER_APPLIES = declaredCondition("series", "marker");

/** Printed lines a `<chart>` stands, when the tag does not say. */
const DEFAULT_CHART_HEIGHT = 8;

/** The fills series are drawn with, in the order series that asked for none are given them. */
const SERIES_PATTERNS = ["solid", "hatch", "dot", "hollow"] as const;

/** The marks plotted points are drawn with, in the order series that asked for none are given them. */
const SERIES_MARKERS = ["circle", "square", "triangle", "cross"] as const;

/** Splits a list of values: a line break separates one from the next as a comma does. */
const VALUE_SEPARATOR = /[\s,]+/;

/** Splits a list of labels, which may hold spaces of their own and so are cut on commas alone. */
const LABEL_SEPARATOR = /[,\n]/;

/**
 * The regions that may sit beside something else on a line, rather than owning whole lines.
 *
 * `<item>` is one of them so that a short list can be written along a single source line, the way a
 * table's row of cells can. Where it prints is unaffected: the list is expanded into one printed line
 * per entry however its source was laid out.
 */
const SHARES_A_LINE: ReadonlySet<string> = new Set(["row", "cell", "series", "labels", "bar", "item"]);

/** A region: a laid-out block, or a list that owns lines without being drawn into one. */
type Region = BlockNode | ListNode | ItemNode;

/** What a list marks its entries with when the tag does not say. */
const DEFAULT_LIST_STYLE: ListStyle = "dash";

/** What `<hr>` is drawn with when the tag carries no `char`. */
const RULE_CHARACTER = "-";

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
	 * it prints nothing: `<drawer><align to=center>x</align>` is an author asking for alignment around
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
	 * What the tag's attributes said the content will become, resolved when the tag opened.
	 *
	 * Null for a block that encloses data: its numbers are read against the chart that holds them,
	 * which is a measurement rather than a shape, so nothing about them is settled here.
	 */
	shape: ContentShape | null;
}

/** A content tag's shape, resolved from its attributes before its content is known. */
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
	node: ScopeNode | AlignNode | WrapNode | Region | null;
	children: Node[];
	line: number;
	column: number;
	/** The line state of the nearest scope that owns lines: a region, or the document. */
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
		const closed = frame.owner.closedOwner;
		// A whole-line block draws its whole line as a picture, so whitespace after it closes is
		// markup rather than content — the same reasoning that already drops it before the opener.
		// Keyed off the closed owner's own code rather than `blockSeen`, which a line-sharing block
		// like `<bar>` sets too: `<align to=center><bar value=50></align>` must still refuse trailing text,
		// because it was the align that closed the line, and nothing may follow `</align>` whatever
		// shares its line.
		if (!(blank && closed?.code === MARKUP_ERRORS.invalidBlockScope)) {
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
		const region = regionName(this.enclosingRegion());
		const holds = region === null ? undefined : HOLDS_ONLY.get(region);
		if (region !== null && holds) {
			throw new MarkupError(
				MARKUP_ERRORS.misplacedBlock,
				line,
				column,
				region,
				`<${region}> holds ${listed(holds)} rather than text`,
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
			// A block that encloses data holds a list, so a break ends one entry and begins the next the
			// way a comma does and has to survive into the content. A symbology's payload is one string
			// instead, and a break in it is the author's margin rather than part of what is encoded.
			if (frame.node?.kind === "block") {
				frame.content.parts.push("\n");
			}
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
	 * though they produce no text yet — `<hr><fill char=.>` would otherwise print a line of dots,
	 * feed, and then the rule.
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

		const attributes = readAttributes(tag.name, token.attributes, tag.attributes, token.line, token.column);
		this.requirePlacement(tag, token.line, token.column);

		if (isContentTag(tag.name)) {
			this.openContent(tag, token, attributes);
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
			case "list":
				this.openList(token, attributes);
				return;
			case "item":
				this.openItem(token, attributes);
				return;
			case "bar":
				this.appendGauge(token, attributes);
				return;
			case "bold":
			case "underline":
			case "invert":
			case "size":
			case "text":
				this.openScope(tag, tag.name, token, attributes);
				return;
			case "align":
				this.openAlign(token, attributes);
				return;
			case "wrap":
			case "nowrap":
				this.openWrap(tag, token);
				return;
			case "fill":
				this.appendFill(token, attributes);
				return;
			case "hr":
				this.appendRule(token, attributes);
				return;
			case "check":
				this.appendCheck(token, attributes);
				return;
			case "cut":
			case "feed":
			case "drawer":
				this.appendVoid(tag, token, attributes);
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
			patch: this.stylePatch(scope, token, attributes),
			line: token.line,
			column: token.column,
			children: [],
		});
	}

	/**
	 * The change one styling tag makes, rather than the style that results.
	 *
	 * @throws MarkupError if `size` names neither dimension, or `text` names a face that is neither a
	 * built-in letter nor a stored font's name, or asks for a size the install does not allow
	 */
	private stylePatch(scope: ScopeTag, token: OpenToken, attributes: Attributes): Partial<SpanStyle> {
		switch (scope) {
			case "bold":
				return { bold: true };
			case "invert":
				return { invert: true };
			case "underline":
				return { underline: ((attributes.weight as number | undefined) ?? 1) as 0 | 1 | 2 };
			case "size": {
				const width = attributes.width as number | undefined;
				const height = attributes.height as number | undefined;
				if (width === undefined && height === undefined) {
					throw new MarkupError(
						MARKUP_ERRORS.invalidAttribute,
						token.line,
						token.column,
						"width",
						"<size> needs width or height, or both",
					);
				}
				return { widthMult: width ?? 1, heightMult: height ?? 1 };
			}
			case "text": {
				const raw = attributes.font as string;
				const builtIn = raw.toUpperCase();
				const size = attributes.size as number | undefined;

				// A size beside a built-in face is refused before this, by the condition the registry
				// states on `size` — so a face resolved here is one that can honour whatever came with it.
				if (Font.is(builtIn)) {
					return { font: builtIn, face: null, faceDots: 24 };
				}

				if (!NAME_PATTERN.test(raw)) {
					throw new MarkupError(
						MARKUP_ERRORS.invalidAttribute,
						token.line,
						attributeColumn(token, "font"),
						"font",
						`<text> font '${raw}' is not a built-in font or a font name`,
					);
				}

				if (size !== undefined && size > this.options.maxFontHeight) {
					throw new MarkupError(
						MARKUP_ERRORS.invalidAttribute,
						token.line,
						attributeColumn(token, "size"),
						"size",
						`<text> size must be at most ${this.options.maxFontHeight}`,
					);
				}
				return { face: raw, faceDots: size ?? 24 };
			}
		}
	}

	private openAlign(token: OpenToken, attributes: Attributes): void {
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

		state.alignSeen = true;
		this.enter(TAGS.align, token, {
			kind: "align",
			align: attributes.to as Align,
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
	 * The attributes are resolved here rather than when the tag closes, so a bad one is refused at
	 * the position it was written and before the rest of the document has been read. The content
	 * cannot be judged until it is complete, so it waits; the attributes have no reason to.
	 */
	private openContent(tag: Tag, token: OpenToken, attributes: Attributes): void {
		this.requireInsideLineScope(token.line, token.column);

		const shape = this.contentShape(tag, attributes);
		this.enter(tag, token, null).content = { tag, parts: [], shape };

		// A symbol is a block of dots the printer places by itself, so it claims the printed line it
		// is placed on. An image claims nothing: it is the one of these the layout engine can place
		// beside text, in a row of glyphs sized to its own dots, and a line holding one is drawn into
		// a raster rather than sent as columns.
		if (tag !== TAGS.image) {
			this.claimLine(tag.name, token.line, token.column, MARKUP_ERRORS.invalidBlockScope);
		}
	}

	/** Reads a content tag's attributes into what its content will become. */
	private contentShape(tag: Tag, attributes: Attributes): ContentShape {
		switch (tag.name) {
			case "qr":
				return { kind: "QR", size: (attributes.size as number | undefined) ?? DEFAULT_QR_MODULE_SIZE };
			case "pdf417":
				return { kind: "PDF417", errorLevel: (attributes.level as number | undefined) ?? DEFAULT_PDF417_ERROR_LEVEL };
			case "barcode":
				return { kind: "BARCODE", system: attributes.type as BarcodeSystem };
			case "image":
				return { kind: "IMAGE", widthPercent: (attributes.width as number | undefined) ?? null };
			default:
				throw new Error(`Tag ${tag.name} encloses markup rather than data`);
		}
	}

	private appendFill(token: OpenToken, attributes: Attributes): void {
		this.requireInsideLineScope(token.line, token.column);

		// The reader has already refused anything but one character.
		const character = (attributes.char as string | undefined) ?? " ";

		const frame = this.frame();
		frame.children.push({ kind: "fill", character, line: token.line, column: token.column });
		frame.owner.fills += 1;
		this.placed(frame.owner);
	}

	private appendRule(token: OpenToken, attributes: Attributes): void {
		this.requireInsideLineScope(token.line, token.column);

		// The reader has already refused anything but one character, the same as it does for `<fill>`.
		const character = (attributes.char as string | undefined) ?? RULE_CHARACTER;

		const frame = this.frame();
		frame.children.push({ kind: "rule", character, line: token.line, column: token.column });
		this.claimLine("hr", token.line, token.column, MARKUP_ERRORS.invalidRuleScope);
		frame.owner.printing += 1;
		this.placed(frame.owner);
	}

	/**
	 * Places a checkbox in the line, beside whatever is written around it.
	 *
	 * No line is claimed and nothing is refused around it, because a checkbox that owned its line
	 * would be a box with its label on the line below. It counts as printing, so a line holding
	 * nothing else is still a printed line.
	 */
	private appendCheck(token: OpenToken, attributes: Attributes): void {
		this.requireInsideLineScope(token.line, token.column);

		const frame = this.frame();
		frame.children.push({
			kind: "check",
			checked: attributes.state === "on",
			line: token.line,
			column: token.column,
		});
		frame.owner.printing += 1;
		this.placed(frame.owner);
	}

	private appendVoid(tag: Tag, token: OpenToken, attributes: Attributes): void {
		this.requireInsideLineScope(token.line, token.column);

		const directive = this.voidDirective(tag, attributes);
		const frame = this.frame();
		frame.children.push({ kind: "void", directive, line: token.line, column: token.column });
		this.placed(frame.owner);
		if (directive.kind !== "DRAWER") {
			frame.owner.printing += 1;
		}
	}

	private voidDirective(tag: Tag, attributes: Attributes): VoidDirective {
		switch (tag.name) {
			case "cut":
				return { kind: "CUT", mode: attributes.mode === "partial" ? "PARTIAL" : "FULL" };
			case "feed":
				return { kind: "FEED", lines: attributes.lines as number };
			case "drawer":
				return { kind: "DRAWER", pin: attributes.pin === "5" ? 5 : 2 };
			default:
				throw new Error(`Tag ${tag.name} is not a directive`);
		}
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
		const inside = regionName(this.enclosingRegion());
		const refuse = (message: string): never => {
			throw new MarkupError(MARKUP_ERRORS.misplacedBlock, line, column, tag.name, message);
		};

		if (inside !== null && PRINTER_DRAWN.has(tag.name)) {
			refuse(`<${tag.name}> is printed by the printer itself, so it cannot sit inside <${inside}>`);
		}

		if (inside === "item" && NOT_IN_AN_ITEM.has(tag.name)) {
			refuse(`<${tag.name}> takes a line of its own, so it cannot sit inside a list's <item>`);
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
		if (SHARES_A_LINE.has(block)) {
			this.requireInsideLineScope(token.line, token.column);
		} else {
			this.requireBlockCanOpen(tag.name, token.line, token.column);
		}
		if (block === "cell") {
			this.countCell(token.line, token.column);
		}
		this.enterRegion(token.line, token.column);

		this.enter(tag, token, {
			kind: "block",
			tag: block,
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
		this.enterRegion(token.line, token.column);

		this.enter(tag, token, {
			kind: "block",
			tag: tag.name as BlockTag,
			attributes,
			content: null,
			children: [],
			line: token.line,
			column: token.column,
		}).content = { tag, parts: [], shape: null };
	}

	// -----------------------------------------------------------------------
	// Lists
	// -----------------------------------------------------------------------

	/**
	 * Opens a list, which owns whole lines the way `<table>` does but is no block.
	 *
	 * A block is a region of dots the server draws; three of the four list styles are characters the
	 * printer has, so a list must not become one or every entry would be sent as a picture. What it
	 * shares with a block is only the line rule: an entry is a line of marker and text, so anything
	 * beside the list on its opening line would have nowhere to print.
	 *
	 * @throws MarkupError if the list cannot own the line it opened on, if it nests past the depth
	 * limit, or if `start` is written on a style that counts nothing
	 */
	private openList(token: OpenToken, attributes: Attributes): void {
		const style = (attributes.style as ListStyle | undefined) ?? DEFAULT_LIST_STYLE;
		const start = attributes.start as number | undefined;
		// Refused rather than ignored, the same answer `<text>` gives `size` on one of the printer's own
		// fonts: a dash list has nothing to count from, so an author who wrote one meant something the
		// list cannot do and should hear so rather than watch it vanish.
		if (start !== undefined && style !== "number" && style !== "letter") {
			throw new MarkupError(
				MARKUP_ERRORS.invalidAttribute,
				token.line,
				attributeColumn(token, "start"),
				"start",
				"<list> start counts from a number, so it applies to a number or letter list only",
			);
		}

		this.requireBlockCanOpen("list", token.line, token.column);
		this.enterRegion(token.line, token.column);

		this.enter(TAGS.list, token, {
			kind: "list",
			style,
			start: start ?? 1,
			line: token.line,
			column: token.column,
			children: [],
		});
	}

	/**
	 * Opens one entry of a list.
	 *
	 * The list it belongs to is already settled — {@link requirePlacement} refuses an `<item>` written
	 * anywhere else — so its style is what decides whether `done` means anything here.
	 *
	 * @throws MarkupError if `done` is written under a style with no box to cross, or the entry nests
	 * past the depth limit
	 */
	private openItem(token: OpenToken, attributes: Attributes): void {
		const list = this.enclosingRegion();
		const style = list?.kind === "list" ? list.style : DEFAULT_LIST_STYLE;
		if (attributes.done !== undefined && style !== "check") {
			throw new MarkupError(
				MARKUP_ERRORS.invalidAttribute,
				token.line,
				attributeColumn(token, "done"),
				"done",
				"<item> done crosses a checkbox, so it applies inside a <list style=check> only",
			);
		}

		this.requireInsideLineScope(token.line, token.column);
		this.enterRegion(token.line, token.column);

		this.enter(TAGS.item, token, {
			kind: "item",
			done: attributes.done === "on",
			line: token.line,
			column: token.column,
			children: [],
		});
	}

	/**
	 * Closes a list or one of its entries: its own last line is verified, and it is placed on the line
	 * that holds it.
	 *
	 * A list closes its line and an entry does not, which is the same distinction `<table>` and
	 * `<row>` already draw: the list is what owns the paper, and the entries are its parts.
	 *
	 * @throws MarkupError if its last line is malformed
	 */
	private closeList(frame: Frame, node: ListNode | ItemNode): void {
		this.endLineOf(frame.owner);
		this.placeBlock(this.frame().owner, node.kind);
	}

	/** Appends a gauge, which encloses nothing: how full it is drawn is its `value`. */
	private appendGauge(token: OpenToken, attributes: Attributes): void {
		this.requireInsideLineScope(token.line, token.column);
		this.enterRegion(token.line, token.column);

		const frame = this.frame();
		frame.children.push({
			kind: "block",
			tag: "bar",
			attributes,
			content: null,
			children: [],
			line: token.line,
			column: token.column,
		});
		this.placeBlock(frame.owner, "bar");
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
	private placeBlock(state: LineState, tag: string): void {
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
	 * plots no points, or the chart's own numbers do not hold together
	 */
	private closeRegion(frame: Frame, node: BlockNode): void {
		frame.owner.blockSeen = true;
		this.endLineOf(frame.owner);

		const marker = node.tag === "chart" ? frame.block?.marker : null;
		if (marker && !conditionMet(MARKER_APPLIES, node.attributes)) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidAttribute,
				marker.line,
				marker.column,
				"marker",
				`<series> marker ${MARKER_APPLIES.because}`,
			);
		}

		if (node.tag === "chart") {
			node.chart = this.readChart(node);
		}

		this.placeBlock(this.frame().owner, node.tag);
	}

	/**
	 * Reads a finished chart's tags into the numbers it plots.
	 *
	 * Read here rather than as each tag closed, because every question worth asking about a chart is
	 * about all of its tags at once: whether a pie was given the one series it can draw, whether the
	 * categories outnumber the points there are categories for, which fill a series takes when it
	 * asked for none. None of those has an answer while the chart is still open.
	 *
	 * @param node the chart, with its series and labels already closed beneath it
	 * @returns what the layout engine draws from
	 * @throws MarkupError if a value is not a number, or the chart holds nothing to plot, more series
	 * than it can draw, a pie slice that is not above zero, labels on a scatter, or more labels than
	 * it has points to name
	 */
	private readChart(node: BlockNode): ChartData {
		const type = node.attributes.type as ChartType;
		const blocks = node.children.filter((child): child is BlockNode => child.kind === "block");
		const seriesBlocks = blocks.filter((child) => child.tag === "series");
		const series = seriesBlocks.map((child, index) => this.readSeries(child, type, index));
		const labelBlocks = blocks.filter((child) => child.tag === "labels");
		const labels = labelBlocks.flatMap((child) =>
			(child.content ?? "")
				.split(LABEL_SEPARATOR)
				.map((label) => label.trim())
				.filter((label) => label.length > 0),
		);

		if (type === "pie" && series.length !== 1) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidTagArgument,
				node.line,
				node.column,
				"chart",
				`a pie divides one whole up, so <chart type=pie> draws exactly one <series>, not ${series.length}`,
			);
		}
		if (!series.some((one) => one.values.length > 0)) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidTagArgument,
				node.line,
				node.column,
				"chart",
				"<chart> draws what its series hold, so it needs a <series> with at least one value",
			);
		}

		// A slice is a share of the whole, and nothing is a share of a whole unless it is more than
		// none of it: a zero takes no angle to draw and a negative one would take an angle back off
		// the slices around it, so neither can be drawn and neither is refused quietly.
		const unshareable = type === "pie" ? series[0].values.find((value) => value <= 0) : undefined;
		if (unshareable !== undefined) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidTagArgument,
				seriesBlocks[0].line,
				seriesBlocks[0].column,
				String(unshareable),
				`a pie divides a whole into shares, so <series> holds values above zero, and ${unshareable} is not one`,
			);
		}

		// A scatter's points carry an x of their own and its horizontal axis is marked with numbers, so
		// there is no category for a label to name and no room under the axis to print one in. Refused
		// rather than ignored: a label an author wrote and the chart never draws is a silent loss.
		if (type === "scatter" && labelBlocks.length > 0) {
			throw new MarkupError(
				MARKUP_ERRORS.misplacedBlock,
				labelBlocks[0].line,
				labelBlocks[0].column,
				"labels",
				"<labels> has no meaning in a scatter chart; its axes carry numbers",
			);
		}

		// The longest series rather than every one of them: a short series leaves its later categories
		// empty the way a short table row leaves its later columns empty, so a label is only surplus
		// when no series reaches that far.
		const plotted = series.reduce((longest, one) => Math.max(longest, one.values.length), 0);
		if (labels.length > plotted) {
			throw new MarkupError(
				MARKUP_ERRORS.tooManyLabels,
				labelBlocks[0].line,
				labelBlocks[0].column,
				String(labels.length),
				`<labels> names the points a chart plots, and ${labels.length} labels name more than the ${plotted} plotted`,
			);
		}

		return {
			type,
			title: (node.attributes.title as string | undefined) ?? null,
			height: (node.attributes.height as number | undefined) ?? DEFAULT_CHART_HEIGHT,
			legend: (node.attributes.legend as ChartData["legend"] | undefined) ?? "auto",
			area: node.attributes.area === "on",
			series,
			labels,
		};
	}

	/**
	 * Reads one series' text into the numbers it plots.
	 *
	 * A scatter's values are pairs and every other chart's are single numbers, but both end up in
	 * `values`: what a series holds is one magnitude per point whatever fixes where that point sits,
	 * so the axis and the legend read the same field for a scatter as for a bar.
	 *
	 * @param node the series, with the text it enclosed
	 * @param type what the chart that holds it is drawn as
	 * @param index where it sits among the chart's series, which decides what it is drawn with
	 * @returns the series
	 * @throws MarkupError if a value is not a number, or the series holds more than the limit allows
	 */
	private readSeries(node: BlockNode, type: ChartType, index: number): Series {
		const tokens = (node.content ?? "").split(VALUE_SEPARATOR).filter((token) => token.length > 0);
		// Counted before any of them is read, so a series far past the limit is refused for its size
		// rather than for whichever of its thousands of values happens to be malformed.
		if (tokens.length > this.options.maxSeriesPoints) {
			throw new MarkupError(
				MARKUP_ERRORS.tooManyPoints,
				node.line,
				node.column,
				String(tokens.length),
				`A series may hold at most ${this.options.maxSeriesPoints} values`,
			);
		}

		const points = type === "scatter" ? tokens.map((token) => this.readPoint(node, token)) : null;
		const values = points ? points.map(([, y]) => y) : tokens.map((token) => this.readValue(node, token, token));

		return {
			label: (node.attributes.name as string | undefined) ?? null,
			pattern:
				(node.attributes.pattern as Series["pattern"] | undefined) ?? SERIES_PATTERNS[index % SERIES_PATTERNS.length],
			marker:
				(node.attributes.marker as Series["marker"] | undefined) ??
				(type === "scatter" ? SERIES_MARKERS[index % SERIES_MARKERS.length] : "none"),
			values,
			points,
		};
	}

	/** Reads one `x:y` pair of a scatter. @throws MarkupError if it is not one */
	private readPoint(node: BlockNode, token: string): [number, number] {
		const halves = token.split(":");
		if (halves.length !== 2) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidTagArgument,
				node.line,
				node.column,
				token,
				`a scatter plots a point at an x and a y, so <series> holds x:y pairs and '${token}' is not one`,
			);
		}
		return [this.readValue(node, halves[0], token), this.readValue(node, halves[1], token)];
	}

	/**
	 * Reads one number a series plots.
	 *
	 * @param node the series it was written in, which the refusal points at
	 * @param text the number itself
	 * @param token what the author wrote, which is the pair rather than the half of it at fault
	 * @returns the number
	 * @throws MarkupError if it is not a finite number
	 */
	private readValue(node: BlockNode, text: string, token: string): number {
		const value = Number(text);
		if (text.length === 0 || !Number.isFinite(value)) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidTagArgument,
				node.line,
				node.column,
				token,
				`<series> plots numbers, and '${token}' is not one`,
			);
		}
		return value;
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
			if (node.kind === "list" || node.kind === "item") {
				this.closeList(frame, node);
			}
			if (node.kind === "scope" || node.kind === "align" || node.kind === "wrap") {
				this.trimLayoutBreaks(node.children);
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
	 * Drops the breaks that only lay a tag out over several lines.
	 *
	 * A tag written on its own line is followed by the newline ending that line, and a closing tag on
	 * its own line is preceded by another. Neither is content: the author indented to be read, and
	 * keeping them prints blank lines nobody wrote, so the same tag laid out over several lines prints
	 * differently from one written on a single line. Exactly one break goes at each end, which leaves a
	 * blank line written deliberately still printing.
	 *
	 * Blocks are not trimmed: a block's breaks belong to the layout engine, which already takes the
	 * first as the end of the line the block opened on.
	 */
	private trimLayoutBreaks(children: Node[]): void {
		if (children[0]?.kind === "break") {
			children.shift();
		}
		if (children[children.length - 1]?.kind === "break") {
			children.pop();
		}
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

	// -----------------------------------------------------------------------
	// Frames
	// -----------------------------------------------------------------------

	private frame(): Frame {
		return this.frames[this.frames.length - 1];
	}

	/**
	 * The region this position is written directly inside, or null at the document's own level.
	 *
	 * Nearest rather than outermost: a region owns a part of the paper, so what a tag may be is
	 * decided by the one immediately around it — a `<cell>` is welcome in a row and nowhere else,
	 * whatever the row itself sits in. Nothing but a region interrupts the walk, because a styling tag
	 * or an alignment inside one is transparent to this: it places nothing of its own.
	 */
	private enclosingRegion(): Region | null {
		for (let at = this.frames.length - 1; at > 0; at--) {
			const node = this.frames[at].node;
			if (node?.kind === "block" || node?.kind === "list" || node?.kind === "item") {
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
	 * A region gets a line state of its own, because its lines are its own: the text in a cell is laid
	 * out against the cell's width and knows nothing of what shares the paper with the table, and a
	 * list's entry is a printed line however its source was laid out. Every other tag inherits the
	 * state of whatever owns the line it was written on, so that a rule written inside two styling tags
	 * still sees what the line already holds.
	 *
	 * A block's own line starts as one a block has already been seen on, so the whitespace written
	 * around its inner tags prints nothing. A list's does too, for the indentation an author puts
	 * before each `<item>`. An entry's does not: what is written inside it is content, and a single
	 * space between two styled runs there is a space the author meant to print.
	 */
	private enter(tag: Tag, token: OpenToken, node: ScopeNode | AlignNode | WrapNode | Region | null): Frame {
		const parent = this.frame();
		const block = node?.kind === "block";
		const frame: Frame = {
			tag,
			node,
			children: node ? node.children : [],
			line: token.line,
			column: token.column,
			owner: block || node?.kind === "list" ? blockLine() : node?.kind === "item" ? freshLine() : parent.owner,
			block: block ? { cells: 0, marker: null } : null,
			content: null,
		};
		this.frames.push(frame);
		return frame;
	}

	/**
	 * Charges one more level of nesting against the depth limit.
	 *
	 * Regions are the only nesting that is bounded, because they are the only nesting whose cost is
	 * not linear in the document's length: a table holds rows, a row holds cells, and every level
	 * measures everything below it. A list is counted with them — its entries hold lists of their own,
	 * and each level widens the marker column the level below it is set in.
	 *
	 * Counted from the frames rather than kept in a field, so the count falls again when a region
	 * closes without anything having to remember to say so.
	 *
	 * @throws MarkupError if the document nests regions deeper than the limit allows
	 */
	enterRegion(line: number, column: number): void {
		const depth = this.frames.filter((frame) => isRegion(frame.node)).length + 1;
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

/** Whether a frame's node is a region: a laid-out block, or a list or one of its entries. */
function isRegion(node: Frame["node"]): boolean {
	return node?.kind === "block" || node?.kind === "list" || node?.kind === "item";
}

/** A region's name as a refusal writes it, which for a list is simply its kind. */
function regionName(node: Region | null): string | null {
	if (node === null) {
		return null;
	}
	return node.kind === "block" ? node.tag : node.kind;
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

/**
 * The condition an attribute declares, or a failure at load time.
 *
 * A rule the registry stopped declaring would otherwise become a rule that quietly stopped being
 * enforced, which is the one way a check driven by a declaration is worse than a check written out.
 *
 * @throws Error if the attribute declares no condition
 */
function declaredCondition(tag: string, attribute: string): AppliesWhen {
	const condition = TAGS[tag]?.attributes[attribute]?.appliesWhen;
	if (!condition) {
		throw new Error(`<${tag}> ${attribute} declares no condition`);
	}
	return condition;
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
