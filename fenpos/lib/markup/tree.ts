import { Align, BarcodeSystem, Font } from "@/lib/domain/enums";
import { readAttributes } from "@/lib/markup/attributes";
import { type SymbolSpec, validateSymbolContent } from "@/lib/markup/blocks";
import type {
	AlignNode,
	BlockNode,
	Document,
	ImageNode,
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
}

/** A tag that encloses data rather than markup, and the data read so far. */
interface ContentState {
	tag: Tag;
	/** One entry per text token. Line breaks contribute nothing, so they add no entry. */
	parts: string[];
	/** What the tag's argument said the content will become, resolved when the tag opened. */
	shape: ContentShape;
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
		this.requireInsideLineScope(token.line, token.column);

		const frame = this.frame();
		if (frame.content) {
			frame.content.parts.push(token.text);
			return;
		}

		frame.children.push({
			kind: "text",
			text: token.text,
			line: token.line,
			column: token.column,
			...(token.expandedFrom === undefined ? {} : { expandedFrom: token.expandedFrom }),
		});
		frame.owner.content = true;
		frame.owner.textSeen = true;
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

	/**
	 * Verifies what the finished line holds, then clears it for the next one.
	 *
	 * A rule expands to the full paper width, and a symbol or an image is a block of dots several
	 * lines tall, so either combined with anything else would overflow its line by construction
	 * rather than by accident. `<drawer>` is exempt because it prints nothing at all: it pulses a
	 * solenoid, so it costs the line no paper and may legally sit beside anything. Fills count even
	 * though they produce no text yet — `<hr><fill=.>` would otherwise print a line of dots, feed,
	 * and then the rule.
	 */
	private endLine(): void {
		const state = this.frame().owner;
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

		state.content = false;
		state.textSeen = false;
		state.fills = 0;
		state.printing = 0;
		state.alignSeen = false;
		state.wrapSeen = false;
		state.soleOccupant = null;
		state.closedOwner = null;
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
		readAttributes(tag.name, token.attributes, tag.attributes, token.line);

		if (isBlockTag(tag.name)) {
			this.openContent(tag, token);
			return;
		}

		switch (tag.name) {
			case "bold":
			case "underline":
			case "invert":
			case "size":
			case "font":
				this.openScope(tag, tag.name, token);
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

	private openScope(tag: Tag, scope: ScopeTag, token: OpenToken): void {
		this.requireInsideLineScope(token.line, token.column);
		this.enter(tag, token, {
			kind: "scope",
			tag: scope,
			patch: this.stylePatch(tag, scope, token.argument, token.line, token.column),
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
				const font = (argument ?? "").toUpperCase();
				if (!Font.is(font)) {
					throw this.argumentError(tag, line, column, "must be 'a' or 'b'");
				}
				return { font };
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

		// A symbol nested in a block is measured against that block's width instead, so only one at
		// the top level is a claim on a printed line of its own.
		if (this.owningFrame() === this.frames[0]) {
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
		frame.owner.content = true;
	}

	private appendRule(token: OpenToken): void {
		this.requireInsideLineScope(token.line, token.column);

		const frame = this.frame();
		frame.children.push({ kind: "rule", line: token.line, column: token.column });
		this.claimLine("hr", token.line, token.column, MARKUP_ERRORS.invalidRuleScope);
		frame.owner.printing += 1;
		frame.owner.content = true;
	}

	private appendVoid(tag: Tag, token: OpenToken): void {
		this.requireInsideLineScope(token.line, token.column);

		const directive = this.voidDirective(tag, token.argument, token.line, token.column);
		const frame = this.frame();
		frame.children.push({ kind: "void", directive, line: token.line, column: token.column });
		frame.owner.content = true;
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
		const node = this.contentNode(frame, content, content.parts.join("").trim());

		const parent = this.frame();
		parent.children.push(node);
		for (let number = frame.line + 1; number < closeLine; number++) {
			this.lines[number - 1].interior = true;
		}
		parent.owner.printing += 1;
		parent.owner.content = true;
	}

	private contentNode(frame: Frame, content: ContentState, data: string): SymbolNode | ImageNode {
		if (content.shape.kind === "IMAGE") {
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
				widthPercent: content.shape.widthPercent,
				line: frame.line,
				column: frame.column,
			};
		}

		const spec: SymbolSpec =
			content.shape.kind === "QR"
				? { kind: "QR", content: data, size: content.shape.size }
				: content.shape.kind === "BARCODE"
					? { kind: "BARCODE", content: data, system: content.shape.system }
					: { kind: "PDF417", content: data, errorLevel: content.shape.errorLevel };

		const refusal = validateSymbolContent(spec);
		if (refusal) {
			throw new MarkupError(MARKUP_ERRORS.invalidTagArgument, frame.line, frame.column, content.tag.name, refusal);
		}
		return { kind: "symbol", spec, line: frame.line, column: frame.column };
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
	 * The frame whose line state applies here: the nearest enclosing block, or the document.
	 *
	 * A block lays out a region of the paper, so its lines are its own — text inside a cell shares
	 * nothing with text beside the table.
	 */
	private owningFrame(): Frame {
		for (let at = this.frames.length - 1; at > 0; at--) {
			if (this.frames[at].node?.kind === "block") {
				return this.frames[at];
			}
		}
		return this.frames[0];
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

	private enter(tag: Tag, token: OpenToken, node: ScopeNode | AlignNode | WrapNode | null): Frame {
		const parent = this.frame();
		const frame: Frame = {
			tag,
			node,
			children: node ? node.children : [],
			line: token.line,
			column: token.column,
			owner: parent.owner,
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
				`Blocks may be nested at most ${this.options.maxBlockDepth} deep`,
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
	};
}
