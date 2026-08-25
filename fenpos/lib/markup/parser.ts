import { Align, BarcodeSystem, Font } from "@/lib/domain/enums";
import {
	pdf417Columns,
	SymbolEncodeError,
	type SymbolGeometry,
	type SymbolSpec,
	symbolGeometry,
	validateSymbolContent,
} from "@/lib/markup/blocks";
import { MARKUP_ERRORS, MarkupError, type MarkupErrorCode } from "@/lib/markup/errors";
import { type Directive, type Fill, type Line, PLAIN, type Span, type SpanStyle } from "@/lib/markup/model";
import { isBlockTag, TAGS, type Tag, tagByName } from "@/lib/markup/tags";
import { hasControlCharacter, VARIABLE_REFERENCE } from "@/lib/variables/definition";

/**
 * Turns one `data` element into a line of styled spans and directives.
 *
 * **This parser is the boundary that makes the rest of the system safe.** Markup is the only way
 * a caller can influence printer state, and every byte the printer would read as a command
 * either comes from a recognised tag or is rejected here. A raw control character is never
 * passed through, so a request cannot desynchronise the device.
 *
 * A single left-to-right pass produces spans carrying fully resolved styles. Control characters
 * are detected during that same pass rather than in a separate sweep, so the reported problem is
 * always the earliest one in the element — which is the one a caller needs to fix first.
 *
 * Ported from `MarkupParser.java`, whose tests are the specification. Both sides had to exist at
 * once during the move: the Java copy is what the agent used to run, this is what the server runs
 * now, and the translated tests are what proves they agree.
 *
 * The block tags — `<qr>`, `<barcode>`, `<pdf417>` and `<image>` — were added after the move and
 * back-ported to the Java parser afterwards, so they too must not drift. `<drawer>` is the one tag
 * with no Java counterpart, deliberately: markup parsed on the agent comes from its own console and
 * from its test page, and neither should be able to fire a cash drawer.
 *
 * What the Java copy cannot do is measure. It has no symbol encoder and no image decoder, so it
 * charges a symbol nothing against its own line budget and resolves an `<image>` only against
 * rasters the server already synced. This side remains the authority on both.
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

/** Printed width of `<image>` when it carries no argument. */
const DEFAULT_IMAGE_WIDTH_PERCENT = MAX_IMAGE_WIDTH_PERCENT;

/** A paired tag currently open, remembering the style to restore when it closes. */
interface OpenTag {
	tag: Tag;
	column: number;
	styleBefore: SpanStyle;
}

/**
 * An image reference being built inside an open `<image>`.
 *
 * Shaped like a {@link SymbolSpec} so the scanner can accumulate into `content` without caring
 * which kind of block it is in, but it is not one: nothing encodes it, and unlike a symbol its
 * printed size cannot be worked out here at all.
 */
interface ImageSpec {
	kind: "IMAGE";
	content: string;
	widthPercent: number;
}

/** What a block tag is building: a symbol to encode, or an image to fetch later. */
type BlockSpec = SymbolSpec | ImageSpec;

/**
 * The block tag currently open, and the symbol or image being built inside it.
 *
 * `spec.content` accumulates the block's text as the scanner passes over it, which is what keeps
 * that text out of `spans`: a line carrying a symbol has to stay directive-only, because the
 * compiler charges it `heightLines` of paper rather than measuring it as text. An image is the
 * same story with the reference in place of the payload.
 */
interface OpenBlock {
	tag: Tag;
	column: number;
	spec: BlockSpec;
}

/**
 * The variable values one compile may substitute.
 *
 * Handed in rather than read, because this parser is synchronous and the values are database rows —
 * the same reason `<image>` geometry arrives through `CompileSettings`. See `resolveVariables` in
 * `lib/markup/resolve-variables.ts` for where it is built.
 */
export interface VariableContext {
	/** Every name this compile can resolve, already flattened across the three layers. */
	values: ReadonlyMap<string, string>;
	/** How many references one element may contain. */
	maxPerElement: number;
}

/**
 * Parses one element of the request's `data` array.
 *
 * @param source the element text, as supplied by the client
 * @param variables the values `{name}` references may resolve to, or null to read braces as
 *        ordinary text — which is what `variables.enabled: false` means, and what every caller
 *        meant before variables existed
 * @returns the parsed line; a blank element yields a line with no spans
 * @throws MarkupError if the element is malformed, carrying the column at fault
 */
export function parseMarkup(source: string | null | undefined, variables?: VariableContext | null): Line {
	return new Parser(source ?? "", variables ?? null).run();
}

/**
 * One element's parse.
 *
 * A class rather than a closure over locals because the state is genuinely a state machine, and
 * naming its fields is what makes the scope rules — one alignment, nothing after it closes —
 * readable rather than implicit.
 */
class Parser {
	private readonly source: string;

	private readonly spans: Span[] = [];
	private readonly fills: Fill[] = [];
	private readonly directives: Directive[] = [];
	private readonly open: OpenTag[] = [];
	private pending = "";

	private style: SpanStyle = PLAIN;
	private align: Align = "LEFT";

	/** Whether an alignment tag has been seen; a second one is an error. */
	private alignSeen = false;

	/** Whether a wrap tag has been seen; <wrap> and <nowrap> share one slot. */
	private wrapSeen = false;

	/** What this line was asked to do about wrapping; null defers to the device. */
	private wrap: boolean | null = null;

	/**
	 * The line-owning tag that has closed, if any.
	 *
	 * `<align>`, `<wrap>` and `<nowrap>` each apply to a whole printed line, so content after
	 * one closes would silently inherit a property the author did not write on it. Remembering
	 * which tag closed is what lets the refusal name the right one.
	 */
	private closedOwner: { name: string; code: MarkupErrorCode } | null = null;

	/**
	 * The block tag currently open, or null when the scanner is reading ordinary text.
	 *
	 * Its presence is what diverts characters away from `pending`, so it is checked by every
	 * path that would otherwise produce a span.
	 */
	private block: OpenBlock | null = null;

	/**
	 * The first directive that must occupy its printed line alone, used to report a violation.
	 *
	 * The first rather than the last, matching this parser's habit of naming the earliest problem
	 * in the element. The code travels with it because `<hr>` and the symbols report different
	 * ones, both of which are frozen parts of the API contract.
	 */
	private soleOccupant: { name: string; column: number; code: MarkupErrorCode } | null = null;

	/** Source column where the text currently accumulating in `pending` began. */
	private pendingColumn = 1;

	private index = 0;

	/** The values `{name}` may resolve to, or null when braces are ordinary text. */
	private readonly variables: VariableContext | null;

	/** How many references this element has substituted, checked against the context's limit. */
	private substitutions = 0;

	constructor(source: string, variables: VariableContext | null) {
		this.source = source;
		this.variables = variables;
	}

	run(): Line {
		while (this.index < this.source.length) {
			const current = this.source[this.index];
			if (current === "<") {
				this.readTag();
			} else if (current === "&") {
				this.readEntity();
			} else if (current === "{") {
				this.readVariable();
			} else {
				this.readText(current);
			}
		}

		this.flushPending();

		if (this.open.length > 0) {
			const unclosed = this.open[this.open.length - 1];
			throw new MarkupError(
				MARKUP_ERRORS.unclosedTag,
				unclosed.column,
				unclosed.tag.name,
				`Tag <${unclosed.tag.name}> was never closed`,
			);
		}

		this.verifyBlockScope();

		return { align: this.align, wrap: this.wrap, spans: this.spans, fills: this.fills, directives: this.directives };
	}

	// -----------------------------------------------------------------------
	// Text
	// -----------------------------------------------------------------------

	private readText(current: string): void {
		if (isControl(current)) {
			throw new MarkupError(
				MARKUP_ERRORS.controlCharacter,
				this.index + 1,
				`U+${(current.charCodeAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
				"Control characters cannot be printed; use markup tags for formatting",
			);
		}
		this.requireInsideLineScope(this.index + 1);
		if (this.block) {
			this.block.spec.content += current;
			this.index++;
			return;
		}
		this.beginPendingAt(this.index + 1);
		this.pending += current;
		this.index++;
	}

	/**
	 * Decodes `&lt;`, `&amp;` and `&lbrace;`.
	 *
	 * Any other ampersand is literal text, because receipts legitimately contain "Fish & Chips"
	 * and rejecting that would be surprising.
	 *
	 * `&lbrace;` joined the other two with variables. It is needed far less often than they are —
	 * a brace is only special when it opens a slug-shaped name that closes, so `{1 of 4}` needs no
	 * escaping — but without it there would be no way at all to print the characters `{phone}` on an
	 * install where `phone` is defined.
	 */
	private readEntity(): void {
		if (this.source.startsWith("&lt;", this.index)) {
			this.emitEntity("<", 4);
			return;
		}
		if (this.source.startsWith("&amp;", this.index)) {
			this.emitEntity("&", 5);
			return;
		}
		if (this.source.startsWith("&lbrace;", this.index)) {
			this.emitEntity("{", 8);
			return;
		}
		this.readText("&");
	}

	/**
	 * Substitutes `{name}`, or leaves the brace as text.
	 *
	 * Only a slug-shaped name is a reference. Anything else — `Table {1 of 4}`, an unclosed brace, a
	 * name with a space in it — falls through to {@link readText} and prints, which is what keeps
	 * braces usable in ordinary receipt text without an escape. `&lbrace;` exists for the remaining
	 * case: printing something that *is* name-shaped.
	 *
	 * A name that is shaped like a reference but resolves to nothing is refused rather than printed.
	 * A typo in a receipt has to be a failure the caller sees, not `{phne}` on a customer's copy.
	 */
	private readVariable(): void {
		const match = this.variables ? VARIABLE_REFERENCE.exec(this.source.slice(this.index)) : null;
		if (!this.variables || !match) {
			this.readText("{");
			return;
		}

		const name = match[1];
		const column = this.index + 1;
		const value = this.variables.values.get(name);

		if (value === undefined) {
			throw new MarkupError(
				MARKUP_ERRORS.unknownVariable,
				column,
				name,
				`No variable named '${name}' is defined for this printer`,
			);
		}

		this.substitutions++;
		if (this.substitutions > this.variables.maxPerElement) {
			throw new MarkupError(
				MARKUP_ERRORS.tooManyVariableReferences,
				column,
				name,
				`At most ${this.variables.maxPerElement} variable references are allowed in one element`,
			);
		}

		// **This check is the boundary, not a nicety.** `readText` refuses a control character as it
		// scans, but `emitEntity` never has — the only things it has ever emitted are `<` and `&`,
		// neither of which can be one. A variable's value is arbitrary text from a database row or a
		// request body, so emitting it unchecked would open a path straight through this parser's
		// stated guarantee: a value holding an ESC would reach the printer as a command. Values are
		// checked at write time too, but this is the check that has to be right.
		if (hasControlCharacter(value)) {
			throw new MarkupError(
				MARKUP_ERRORS.controlCharacter,
				column,
				name,
				`The value of '${name}' contains a control character, which cannot be printed`,
			);
		}

		this.emitEntity(value, match[0].length);
	}

	/**
	 * Emits one decoded entity, or one substituted variable value, as a span of its own.
	 *
	 * Isolating it keeps every other span's characters contiguous in the source, which is what
	 * lets a column be reported exactly: both an entity and a reference consume more source
	 * characters than they produce, so a span spanning one could not be measured by simple
	 * arithmetic. A variable makes that gap far wider than `&amp;` ever did — a four-character
	 * `{x}` can produce two hundred — which is the same property, only more so.
	 *
	 * Inside a block the decoded text joins the symbol's content instead. A URL carrying a
	 * query string is the ordinary case — `&amp;` is the only way to write its separator — and
	 * `<qr>{site}</qr>` is the variable equivalent.
	 *
	 * Emitting nothing when the text is empty, rather than pushing an empty span: a variable whose
	 * value is legitimately blank must not leave a span behind, because `isDirectiveOnly` reads a
	 * line's spans to decide whether it advances the paper.
	 *
	 * @param decoded the character the entity stands for, or the variable's value
	 * @param sourceLength how many source characters it occupies
	 */
	private emitEntity(decoded: string, sourceLength: number): void {
		this.requireInsideLineScope(this.index + 1);
		if (this.block) {
			this.block.spec.content += decoded;
			this.index += sourceLength;
			return;
		}
		this.flushPending();
		if (decoded.length > 0) {
			this.spans.push({ text: decoded, style: this.style, sourceColumn: this.index + 1 });
		}
		this.index += sourceLength;
	}

	/** Records where the current run of text started, if it has not started already. */
	private beginPendingAt(column: number): void {
		if (this.pending.length === 0) {
			this.pendingColumn = column;
		}
	}

	private flushPending(): void {
		if (this.pending.length === 0) {
			return;
		}
		this.spans.push({ text: this.pending, style: this.style, sourceColumn: this.pendingColumn });
		this.pending = "";
	}

	// -----------------------------------------------------------------------
	// Tags
	// -----------------------------------------------------------------------

	private readTag(): void {
		const startColumn = this.index + 1;
		const close = this.source.indexOf(">", this.index);
		if (close < 0) {
			throw new MarkupError(
				MARKUP_ERRORS.unknownTag,
				startColumn,
				this.source.slice(this.index),
				"Unterminated tag; write &lt; for a literal '<'",
			);
		}

		const body = this.source.slice(this.index + 1, close);
		this.index = close + 1;

		if (body.startsWith("/")) {
			this.closeTag(body.slice(1), startColumn);
		} else {
			this.openTag(body, startColumn);
		}
	}

	private openTag(body: string, column: number): void {
		const equals = body.indexOf("=");
		const name = equals < 0 ? body : body.slice(0, equals);
		const argument = equals < 0 ? null : body.slice(equals + 1);

		const tag = tagByName(name);
		if (!tag) {
			throw new MarkupError(
				MARKUP_ERRORS.unknownTag,
				column,
				name,
				`Unknown tag '${name}'; write &lt; for a literal '<'`,
			);
		}

		if (this.block) {
			this.refuseInsideBlock(this.block, tag, column);
		}

		this.requireArgumentPolicy(tag, argument, column);

		// Void, but not a directive: a fill is a position in the text rather than a printer action,
		// so it never reaches `appendDirective`.
		if (tag.name === "fill") {
			this.appendFill(argument, column);
			return;
		}

		if (tag.kind === "VOID") {
			this.appendDirective(tag, argument, column);
			return;
		}

		this.flushPending();

		if (tag.name === "align") {
			this.openAlign(argument, column);
			return;
		}

		if (tag.name === "wrap" || tag.name === "nowrap") {
			this.openWrap(tag, column);
			return;
		}

		if (isBlockTag(tag.name)) {
			this.openBlock(tag, argument, column);
			return;
		}

		this.requireInsideLineScope(column);
		this.open.push({ tag, column, styleBefore: this.style });
		this.style = this.applyStyle(tag, argument, column);
	}

	private closeTag(name: string, column: number): void {
		const tag = tagByName(name);
		if (!tag) {
			throw new MarkupError(MARKUP_ERRORS.unknownTag, column, name, `Unknown tag '${name}'`);
		}

		if (this.block && this.block.tag !== tag) {
			this.refuseInsideBlock(this.block, tag, column);
		}

		if (tag.kind === "VOID") {
			throw new MarkupError(
				MARKUP_ERRORS.unexpectedCloseTag,
				column,
				tag.name,
				`<${tag.name}> stands alone and cannot be closed`,
			);
		}

		this.flushPending();

		if (tag.name === "align") {
			this.closeAlign(column);
			return;
		}

		if (tag.name === "wrap" || tag.name === "nowrap") {
			this.closeWrap(tag, column);
			return;
		}

		const current = this.open[this.open.length - 1];
		if (!current || current.tag !== tag) {
			const expected = current ? `expected </${current.tag.name}>` : "no tag is open";
			throw new MarkupError(
				MARKUP_ERRORS.unexpectedCloseTag,
				column,
				tag.name,
				`</${tag.name}> does not match: ${expected}`,
			);
		}

		this.open.pop();
		this.style = current.styleBefore;

		if (this.block) {
			this.closeBlock(this.block);
		}
	}

	/**
	 * Applies a tag's effect to the current style.
	 *
	 * @throws MarkupError if the argument is malformed or out of range
	 */
	private applyStyle(tag: Tag, argument: string | null, column: number): SpanStyle {
		switch (tag.name) {
			case "bold":
				return { ...this.style, bold: true };
			case "invert":
				return { ...this.style, invert: true };
			case "underline": {
				const thickness = argument === null ? 1 : this.requireInt(argument, 1, 2, tag, column);
				return { ...this.style, underline: thickness as 0 | 1 | 2 };
			}
			case "size":
				return this.applySize(argument as string, column);
			case "font": {
				const font = (argument ?? "").toUpperCase();
				if (!Font.is(font)) {
					throw this.argumentError(tag, column, "must be 'a' or 'b'");
				}
				return { ...this.style, font };
			}
			default:
				throw new Error(`Tag ${tag.name} does not carry a span style`);
		}
	}

	private applySize(argument: string, column: number): SpanStyle {
		const parts = argument.split(",");
		if (parts.length > 2) {
			throw this.argumentError(TAGS.size, column, "expected W or W,H");
		}
		const width = this.requireInt(parts[0], 1, MAX_SIZE_MULTIPLIER, TAGS.size, column);
		const height = parts.length === 1 ? width : this.requireInt(parts[1], 1, MAX_SIZE_MULTIPLIER, TAGS.size, column);
		return { ...this.style, widthMult: width, heightMult: height };
	}

	// -----------------------------------------------------------------------
	// Alignment
	// -----------------------------------------------------------------------

	private openAlign(argument: string | null, column: number): void {
		if (this.alignSeen) {
			throw new MarkupError(MARKUP_ERRORS.invalidAlignScope, column, "align", "Only one <align> is allowed per line");
		}
		this.requireLineOwnerCanOpen("align", MARKUP_ERRORS.invalidAlignScope, column);

		const value = (argument ?? "").toUpperCase();
		if (!Align.is(value)) {
			throw this.argumentError(TAGS.align, column, "must be 'left', 'center' or 'right'");
		}

		this.align = value;
		this.alignSeen = true;
		this.open.push({ tag: TAGS.align, column, styleBefore: this.style });
	}

	private closeAlign(column: number): void {
		const current = this.open[this.open.length - 1];
		if (!current || current.tag.name !== "align") {
			throw new MarkupError(
				MARKUP_ERRORS.unexpectedCloseTag,
				column,
				"align",
				"</align> does not match any open <align>",
			);
		}
		this.open.pop();
		this.style = current.styleBefore;
		this.closedOwner = { name: "align", code: MARKUP_ERRORS.invalidAlignScope };
	}

	// -----------------------------------------------------------------------
	// Wrapping
	// -----------------------------------------------------------------------

	/**
	 * Opens `<wrap>` or `<nowrap>`.
	 *
	 * Both occupy one slot: a line either wraps or it does not, so writing both is a
	 * contradiction rather than a refinement.
	 */
	private openWrap(tag: Tag, column: number): void {
		if (this.wrapSeen) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidWrapScope,
				column,
				tag.name,
				"Only one <wrap> or <nowrap> is allowed per line",
			);
		}
		this.requireLineOwnerCanOpen(tag.name, MARKUP_ERRORS.invalidWrapScope, column);

		this.wrap = tag.name === "wrap";
		this.wrapSeen = true;
		this.open.push({ tag, column, styleBefore: this.style });
	}

	private closeWrap(tag: Tag, column: number): void {
		const current = this.open[this.open.length - 1];
		if (!current || current.tag !== tag) {
			throw new MarkupError(
				MARKUP_ERRORS.unexpectedCloseTag,
				column,
				tag.name,
				`</${tag.name}> does not match any open <${tag.name}>`,
			);
		}
		this.open.pop();
		this.style = current.styleBefore;
		this.closedOwner = { name: tag.name, code: MARKUP_ERRORS.invalidWrapScope };
	}

	/**
	 * Rejects content appearing after a line-owning tag has closed.
	 *
	 * Alignment and wrapping both apply to a whole printed line, so text outside the tag would
	 * silently inherit a property the author did not write. Refusing is better than guessing.
	 */
	private requireInsideLineScope(column: number): void {
		if (this.closedOwner) {
			throw new MarkupError(
				this.closedOwner.code,
				column,
				this.closedOwner.name,
				`<${this.closedOwner.name}> must enclose the whole line, so nothing may follow </${this.closedOwner.name}>`,
			);
		}
	}

	/**
	 * Rejects a line-owning tag that cannot legally open here.
	 *
	 * Another line-owning tag may already be open — that is the nesting the language allows, in
	 * either order — but text or a directive before it means the tag does not own the line.
	 */
	private requireLineOwnerCanOpen(name: string, code: MarkupErrorCode, column: number): void {
		this.requireInsideLineScope(column);
		// Text or a directive already emitted disqualifies the tag from owning the line. So does
		// opening inside a styling tag: styling adds nothing to `spans` or `directives` until it
		// closes, so without this check `<bold><nowrap>` would slip past undetected.
		const precededByContent = this.spans.length > 0 || this.directives.length > 0;
		const nestedInsideStyling = this.open.some((entry) => !isLineOwningTag(entry.tag.name));
		if (precededByContent || nestedInsideStyling) {
			throw new MarkupError(code, column, name, `<${name}> must enclose the whole line, so nothing may precede it`);
		}
	}

	// -----------------------------------------------------------------------
	// Blocks
	// -----------------------------------------------------------------------

	/**
	 * Opens `<qr>`, `<barcode>`, `<pdf417>` or `<image>`.
	 *
	 * Pushed onto the same tag stack as any other paired tag, so an unclosed block is reported by
	 * the same check that catches an unclosed `<bold>`. What differs is the parallel {@link block}
	 * field: while it is set the scanner writes into the symbol's content instead of into a span.
	 */
	private openBlock(tag: Tag, argument: string | null, column: number): void {
		this.requireInsideLineScope(column);
		this.open.push({ tag, column, styleBefore: this.style });
		this.block = { tag, column, spec: this.emptyBlock(tag, argument, column) };
	}

	/**
	 * Builds what a block will carry, with its content still to be read.
	 *
	 * The argument is resolved when the block opens rather than when it closes, so a bad one is
	 * refused at the position it was written and before the rest of the element has been scanned.
	 *
	 * @throws MarkupError if the argument is not a size, error level, symbology or width this tag
	 *         accepts
	 */
	private emptyBlock(tag: Tag, argument: string | null, column: number): BlockSpec {
		switch (tag.name) {
			case "image":
				return {
					kind: "IMAGE",
					content: "",
					widthPercent:
						argument === null
							? DEFAULT_IMAGE_WIDTH_PERCENT
							: this.requireInt(argument, MIN_IMAGE_WIDTH_PERCENT, MAX_IMAGE_WIDTH_PERCENT, tag, column),
				};
			case "qr":
				return {
					kind: "QR",
					content: "",
					size:
						argument === null ? DEFAULT_QR_MODULE_SIZE : this.requireInt(argument, 1, MAX_QR_MODULE_SIZE, tag, column),
				};
			case "pdf417":
				return {
					kind: "PDF417",
					content: "",
					errorLevel:
						argument === null
							? DEFAULT_PDF417_ERROR_LEVEL
							: this.requireInt(argument, 0, MAX_PDF417_ERROR_LEVEL, tag, column),
				};
			case "barcode": {
				const system = (argument ?? "").toUpperCase();
				if (!BarcodeSystem.is(system)) {
					throw this.argumentError(tag, column, `must name a symbology: ${BarcodeSystem.values.join(", ")}`);
				}
				return { kind: "BARCODE", content: "", system };
			}
			default:
				throw new Error(`Tag ${tag.name} is not a block`);
		}
	}

	/**
	 * Closes a block, turning the content it captured into a directive.
	 *
	 * Validation happens here, where the whole payload is finally known, and reports the opening
	 * tag's column: the content runs to the end of the block, so the tag that says how it will be
	 * encoded is the more useful thing to point a caller at.
	 *
	 * @throws MarkupError if the symbology cannot encode this content, or an image names nothing
	 */
	private closeBlock(block: OpenBlock): void {
		const spec = block.spec;
		const directive = spec.kind === "IMAGE" ? this.imageDirective(block, spec) : this.symbolDirective(block, spec);

		this.claimLine(block.tag.name, block.column, MARKUP_ERRORS.invalidBlockScope);
		this.directives.push(directive);
		this.block = null;
	}

	/**
	 * Turns a finished symbol into its directive, validated and measured.
	 *
	 * @throws MarkupError if the symbology refuses this content
	 */
	private symbolDirective(block: OpenBlock, spec: SymbolSpec): Directive {
		const refusal = validateSymbolContent(spec);
		if (refusal) {
			throw new MarkupError(MARKUP_ERRORS.invalidTagArgument, block.column, block.tag.name, refusal);
		}
		return blockDirective(spec, this.measure(block, spec), block.column);
	}

	/**
	 * Turns a finished image reference into its directive, unmeasured.
	 *
	 * The one block that leaves the parser without a height. Whether `ref` names anything — a
	 * stored asset, a host that answers — is not knowable from the element either, so the only
	 * check available here is that something was written at all. The rest is the compiler's
	 * pre-pass, which reports a missing asset or an unreachable host as its own refusal.
	 *
	 * @throws MarkupError if the tags enclose nothing
	 */
	private imageDirective(block: OpenBlock, spec: ImageSpec): Directive {
		if (spec.content.length === 0) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidTagArgument,
				block.column,
				block.tag.name,
				"<image> must enclose a stored image's name or an http(s) URL",
			);
		}
		return { kind: "IMAGE", ref: spec.content, widthPercent: spec.widthPercent };
	}

	/**
	 * Measures the symbol, turning an encoder refusal into a markup error.
	 *
	 * `validateSymbolContent` checks format only — length and alphabet — because check-digit
	 * arithmetic belongs to the encoder that computes it. When the encoder is the one to refuse,
	 * the caller still deserves a 400 naming the tag rather than an unhandled fault.
	 *
	 * Only a {@link SymbolEncodeError} is converted. Anything else thrown while measuring is a
	 * fault on this side, and reporting it as a 400 would both tell the caller to fix content
	 * that is fine and hide a server defect from the error rate that is supposed to show it.
	 */
	private measure(block: OpenBlock, spec: SymbolSpec): SymbolGeometry {
		try {
			return symbolGeometry(spec);
		} catch (thrown) {
			if (!(thrown instanceof SymbolEncodeError)) {
				throw thrown;
			}
			throw new MarkupError(
				MARKUP_ERRORS.invalidTagArgument,
				block.column,
				block.tag.name,
				`<${block.tag.name}> cannot encode this content: ${thrown.message}`,
			);
		}
	}

	/**
	 * Rejects a tag written inside an open block.
	 *
	 * A block encloses the payload of a symbology — a URL, an article number — not markup, so a
	 * tag nested in one would have no effect on the printed symbol. Refusing says so, rather than
	 * discarding it silently.
	 */
	private refuseInsideBlock(block: OpenBlock, tag: Tag, column: number): never {
		throw new MarkupError(
			MARKUP_ERRORS.invalidBlockScope,
			column,
			tag.name,
			`<${block.tag.name}> encloses data rather than markup, so <${tag.name}> cannot appear inside it`,
		);
	}

	// -----------------------------------------------------------------------
	// Directives
	// -----------------------------------------------------------------------

	private appendDirective(tag: Tag, argument: string | null, column: number): void {
		this.requireInsideLineScope(column);
		switch (tag.name) {
			case "cut":
				this.directives.push({ kind: "CUT", mode: this.cutMode(argument, column) });
				return;
			case "feed":
				this.directives.push({
					kind: "FEED",
					lines: this.requireInt(argument as string, 1, MAX_FEED_LINES, tag, column),
				});
				return;
			case "hr":
				this.claimLine("hr", column, MARKUP_ERRORS.invalidRuleScope);
				this.directives.push({ kind: "RULE" });
				return;
			case "drawer":
				this.directives.push({ kind: "DRAWER", pin: this.drawerPin(argument, column) });
				return;
			default:
				throw new Error(`Tag ${tag.name} is not a directive`);
		}
	}

	/**
	 * Records a pad, to be expanded when the column count is known.
	 *
	 * `flushPending` first is load-bearing. `pending` holds text that has not become a span yet, so
	 * without it `Coffee<fill>2.50` would record `afterSpans: 0` and pad the wrong side of the word.
	 */
	private appendFill(argument: string | null, column: number): void {
		this.requireInsideLineScope(column);

		const character = argument ?? " ";
		// Code points, not UTF-16 units: an astral character is one character and two units, and
		// measuring units would refuse a legitimate single character as though it were two.
		if ([...character].length !== 1) {
			throw this.argumentError(TAGS.fill, column, "takes a single character, written <fill=x>");
		}

		this.flushPending();
		this.fills.push({ afterSpans: this.spans.length, character, style: this.style, sourceColumn: column });
	}

	private cutMode(argument: string | null, column: number): "FULL" | "PARTIAL" {
		if (argument === null || argument.toLowerCase() === "full") {
			return "FULL";
		}
		if (argument.toLowerCase() === "partial") {
			return "PARTIAL";
		}
		throw this.argumentError(TAGS.cut, column, "must be 'full' or 'partial'");
	}

	private drawerPin(argument: string | null, column: number): 2 | 5 {
		if (argument === null || argument === "2") {
			return 2;
		}
		if (argument === "5") {
			return 5;
		}
		throw this.argumentError(TAGS.drawer, column, "must be pin 2 or 5");
	}

	/** Records a directive that must be the only thing printed on its line. */
	private claimLine(name: string, column: number, code: MarkupErrorCode): void {
		this.soleOccupant ??= { name, column, code };
	}

	/**
	 * Rejects a rule, a symbol or an image sharing its element with anything else.
	 *
	 * A rule expands to the full paper width, and a symbol or an image is a block of dots several
	 * lines tall, so either combined with text would overflow its line by construction rather than
	 * by accident. `<drawer>` is exempt because it prints nothing at all: it pulses a solenoid, so
	 * it costs the line no paper and may legally sit beside anything.
	 */
	private verifyBlockScope(): void {
		if (!this.soleOccupant) {
			return;
		}
		const printing = this.directives.filter((directive) => directive.kind !== "DRAWER");
		// Fills count towards sharing even though they produce no span yet. `<hr><fill=.>` would
		// otherwise print a line of dots, feed, and then the rule — one element, two lines of paper.
		if (this.spans.length === 0 && this.fills.length === 0 && printing.length === 1) {
			return;
		}
		throw new MarkupError(
			this.soleOccupant.code,
			this.soleOccupant.column,
			this.soleOccupant.name,
			`<${this.soleOccupant.name}> takes a whole line and must be alone in its element`,
		);
	}

	// -----------------------------------------------------------------------
	// Shared checks
	// -----------------------------------------------------------------------

	private requireArgumentPolicy(tag: Tag, argument: string | null, column: number): void {
		const supplied = argument !== null;
		if (supplied && tag.argument === "NONE") {
			throw this.argumentError(tag, column, "takes no argument");
		}
		if (!supplied && tag.argument === "REQUIRED") {
			throw this.argumentError(tag, column, `requires an argument, written <${tag.name}=value>`);
		}
		if (supplied && argument.length === 0) {
			throw this.argumentError(tag, column, "has an empty argument");
		}
	}

	private requireInt(value: string, min: number, max: number, tag: Tag, column: number): number {
		const trimmed = value.trim();
		// Checked with a pattern rather than by parsing, because parseInt("3px") is 3 and
		// Number(" ") is 0 — both would accept an argument the Java parser refuses.
		if (!/^[+-]?\d+$/.test(trimmed)) {
			throw this.argumentError(tag, column, `'${value}' is not a number`);
		}
		const parsed = Number.parseInt(trimmed, 10);
		if (parsed < min || parsed > max) {
			throw this.argumentError(tag, column, `must be between ${min} and ${max}, got ${parsed}`);
		}
		return parsed;
	}

	private argumentError(tag: Tag, column: number, detail: string): MarkupError {
		return new MarkupError(MARKUP_ERRORS.invalidTagArgument, column, tag.name, `<${tag.name}> ${detail}`);
	}
}

/**
 * Returns whether a character would be consumed by the printer as a command rather than printed.
 *
 * Covers C0 (including tab, whose behaviour depends on printer-side tab stops that the agent
 * does not manage), DEL, and C1.
 *
 * @param value the character to test
 * @returns true when it must not reach the printer
 */
function isControl(value: string): boolean {
	const code = value.charCodeAt(0);
	return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * Turns a finished symbol into the directive that carries it.
 *
 * The size comes from {@link symbolGeometry} rather than from anything computed here, so the paper
 * the compiler's budget charges for a symbol, and the height and width the preview draws it at, are
 * the same measurement by construction.
 *
 * The opening tag's column travels with it, because the compiler is where a symbol is finally
 * compared against the paper's width and by then the element text is gone. The opening tag rather
 * than the closing one, matching what every other refusal about this block points at: the tag that
 * says how the content will be encoded is the more useful thing to show a caller.
 *
 * @param spec the symbol, with its content complete
 * @param geometry the symbol's measured size
 * @param sourceColumn the column the opening tag was written at
 * @returns the directive to append to the line
 */
function blockDirective(spec: SymbolSpec, geometry: SymbolGeometry, sourceColumn: number): Directive {
	const measured = { heightLines: geometry.heightLines, widthDots: geometry.widthDots, sourceColumn };
	switch (spec.kind) {
		case "QR":
			return { kind: "QR", content: spec.content, size: spec.size, ...measured };
		case "BARCODE":
			return { kind: "BARCODE", system: spec.system, content: spec.content, ...measured };
		case "PDF417":
			return {
				kind: "PDF417",
				content: spec.content,
				errorLevel: spec.errorLevel,
				columns: pdf417Columns(geometry.widthDots),
				...measured,
			};
	}
}

/**
 * Whether a tag applies to a whole printed line, as opposed to styling a run of text.
 *
 * `<align>`, `<wrap>` and `<nowrap>` may nest each other in any order; nesting one inside a
 * styling tag is not "enclosing the whole line" and must be refused.
 */
function isLineOwningTag(name: string): boolean {
	return name === "align" || name === "wrap" || name === "nowrap";
}
