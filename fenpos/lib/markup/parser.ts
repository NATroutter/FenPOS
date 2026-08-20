import { Align, BarcodeSystem, Font } from "@/lib/domain/enums";
import {
	SymbolEncodeError,
	type SymbolGeometry,
	type SymbolSpec,
	symbolGeometry,
	validateSymbolContent,
} from "@/lib/markup/blocks";
import { MARKUP_ERRORS, MarkupError, type MarkupErrorCode } from "@/lib/markup/errors";
import { type Directive, type Line, PLAIN, type Span, type SpanStyle } from "@/lib/markup/model";
import { isBlockTag, TAGS, type Tag, tagByName } from "@/lib/markup/tags";

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
 * The block tags — `<qr>`, `<barcode>`, `<pdf417>` and `<drawer>` — are the exception, and have
 * no Java counterpart. They were added after the server became the only side that parses markup,
 * so the agent receives them already compiled and never sees the syntax.
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

/** A paired tag currently open, remembering the style to restore when it closes. */
interface OpenTag {
	tag: Tag;
	column: number;
	styleBefore: SpanStyle;
}

/**
 * The block tag currently open, and the symbol being built inside it.
 *
 * `spec.content` accumulates the block's text as the scanner passes over it, which is what keeps
 * that text out of `spans`: a line carrying a symbol has to stay directive-only, because the
 * compiler charges it `heightLines` of paper rather than measuring it as text.
 */
interface OpenBlock {
	tag: Tag;
	column: number;
	spec: SymbolSpec;
}

/**
 * Parses one element of the request's `data` array.
 *
 * @param source the element text, as supplied by the client
 * @returns the parsed line; a blank element yields a line with no spans
 * @throws MarkupError if the element is malformed, carrying the column at fault
 */
export function parseMarkup(source: string | null | undefined): Line {
	return new Parser(source ?? "").run();
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

	constructor(source: string) {
		this.source = source;
	}

	run(): Line {
		while (this.index < this.source.length) {
			const current = this.source[this.index];
			if (current === "<") {
				this.readTag();
			} else if (current === "&") {
				this.readEntity();
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

		return { align: this.align, wrap: this.wrap, spans: this.spans, directives: this.directives };
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
	 * Decodes `&lt;` and `&amp;`.
	 *
	 * Any other ampersand is literal text, because receipts legitimately contain "Fish & Chips"
	 * and rejecting that would be surprising.
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
		this.readText("&");
	}

	/**
	 * Emits one decoded entity as a span of its own.
	 *
	 * Isolating it keeps every other span's characters contiguous in the source, which is what
	 * lets a column be reported exactly: an entity consumes more source characters than it
	 * produces, so a span spanning one could not be measured by simple arithmetic.
	 *
	 * Inside a block the decoded character joins the symbol's content instead. A URL carrying a
	 * query string is the ordinary case — `&amp;` is the only way to write its separator — so the
	 * entity has to survive into the encoded payload rather than into a span.
	 *
	 * @param decoded the character the entity stands for
	 * @param sourceLength how many source characters the entity occupies
	 */
	private emitEntity(decoded: string, sourceLength: number): void {
		this.requireInsideLineScope(this.index + 1);
		if (this.block) {
			this.block.spec.content += decoded;
			this.index += sourceLength;
			return;
		}
		this.flushPending();
		this.spans.push({ text: decoded, style: this.style, sourceColumn: this.index + 1 });
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
	 * Opens `<qr>`, `<barcode>` or `<pdf417>`.
	 *
	 * Pushed onto the same tag stack as any other paired tag, so an unclosed block is reported by
	 * the same check that catches an unclosed `<bold>`. What differs is the parallel {@link block}
	 * field: while it is set the scanner writes into the symbol's content instead of into a span.
	 */
	private openBlock(tag: Tag, argument: string | null, column: number): void {
		this.requireInsideLineScope(column);
		this.open.push({ tag, column, styleBefore: this.style });
		this.block = { tag, column, spec: this.emptySymbol(tag, argument, column) };
	}

	/**
	 * Builds the symbol a block will encode, with its content still to be read.
	 *
	 * The argument is resolved when the block opens rather than when it closes, so a bad one is
	 * refused at the position it was written and before the rest of the element has been scanned.
	 *
	 * @throws MarkupError if the argument is not a size, error level or symbology this tag accepts
	 */
	private emptySymbol(tag: Tag, argument: string | null, column: number): SymbolSpec {
		switch (tag.name) {
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
	 * Validation and measurement both happen here, where the whole payload is finally known, and
	 * both report the opening tag's column: the content runs to the end of the block, so the tag
	 * that says how it will be encoded is the more useful thing to point a caller at.
	 *
	 * @throws MarkupError if the symbology cannot encode this content
	 */
	private closeBlock(block: OpenBlock): void {
		const refusal = validateSymbolContent(block.spec);
		if (refusal) {
			throw new MarkupError(MARKUP_ERRORS.invalidTagArgument, block.column, block.tag.name, refusal);
		}

		const geometry = this.measure(block);
		this.claimLine(block.tag.name, block.column, MARKUP_ERRORS.invalidBlockScope);
		this.directives.push(blockDirective(block.spec, geometry));
		this.block = null;
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
	private measure(block: OpenBlock): SymbolGeometry {
		try {
			return symbolGeometry(block.spec);
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
	 * Rejects a rule or a symbol sharing its element with anything else.
	 *
	 * A rule expands to the full paper width and a symbol is a block of dots several lines tall,
	 * so either combined with text would overflow its line by construction rather than by
	 * accident. `<drawer>` is exempt because it prints nothing at all: it pulses a solenoid, so
	 * it costs the line no paper and may legally sit beside anything.
	 */
	private verifyBlockScope(): void {
		if (!this.soleOccupant) {
			return;
		}
		const printing = this.directives.filter((directive) => directive.kind !== "DRAWER");
		if (this.spans.length === 0 && printing.length === 1) {
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
 * @param spec the symbol, with its content complete
 * @param geometry the symbol's measured size
 * @returns the directive to append to the line
 */
function blockDirective(spec: SymbolSpec, geometry: SymbolGeometry): Directive {
	const measured = { heightLines: geometry.heightLines, widthDots: geometry.widthDots };
	switch (spec.kind) {
		case "QR":
			return { kind: "QR", content: spec.content, size: spec.size, ...measured };
		case "BARCODE":
			return { kind: "BARCODE", system: spec.system, content: spec.content, ...measured };
		case "PDF417":
			return { kind: "PDF417", content: spec.content, errorLevel: spec.errorLevel, ...measured };
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
