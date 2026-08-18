import { Align, Font } from "@/lib/domain/enums";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import { type Directive, type Line, PLAIN, type Span, type SpanStyle } from "@/lib/markup/model";
import { TAGS, type Tag, tagByName } from "@/lib/markup/tags";

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
 */

/** Highest permitted character multiplier, imposed by ESC/POS `GS !`. */
const MAX_SIZE_MULTIPLIER = 8;

/** Highest permitted feed distance, imposed by ESC/POS `ESC d`. */
const MAX_FEED_LINES = 255;

/** A paired tag currently open, remembering the style to restore when it closes. */
interface OpenTag {
	tag: Tag;
	column: number;
	styleBefore: SpanStyle;
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

	/** Whether alignment has closed; content after that point is outside its scope. */
	private alignClosed = false;

	/** Column of the rule tag, or 0 if none, used to report a scope violation. */
	private ruleColumn = 0;

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

		this.verifyRuleScope();

		return { align: this.align, spans: this.spans, directives: this.directives };
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
		this.requireInsideAlignScope(this.index + 1);
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
	 * @param decoded the character the entity stands for
	 * @param sourceLength how many source characters the entity occupies
	 */
	private emitEntity(decoded: string, sourceLength: number): void {
		this.requireInsideAlignScope(this.index + 1);
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

		this.requireInsideAlignScope(column);
		this.open.push({ tag, column, styleBefore: this.style });
		this.style = this.applyStyle(tag, argument, column);
	}

	private closeTag(name: string, column: number): void {
		const tag = tagByName(name);
		if (!tag) {
			throw new MarkupError(MARKUP_ERRORS.unknownTag, column, name, `Unknown tag '${name}'`);
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
		if (this.spans.length > 0 || this.directives.length > 0) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidAlignScope,
				column,
				"align",
				"<align> must enclose the whole line, so nothing may precede it",
			);
		}

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
		this.alignClosed = true;
	}

	/**
	 * Rejects content appearing after `</align>`.
	 *
	 * Alignment applies to a whole printed line, so text outside the tag would silently inherit
	 * an alignment the author did not write. Refusing is better than guessing.
	 */
	private requireInsideAlignScope(column: number): void {
		if (this.alignClosed) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidAlignScope,
				column,
				"align",
				"<align> must enclose the whole line, so nothing may follow </align>",
			);
		}
	}

	// -----------------------------------------------------------------------
	// Directives
	// -----------------------------------------------------------------------

	private appendDirective(tag: Tag, argument: string | null, column: number): void {
		this.requireInsideAlignScope(column);
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
				this.ruleColumn = column;
				this.directives.push({ kind: "RULE" });
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

	/**
	 * Rejects a rule sharing its element with anything else.
	 *
	 * A rule expands to the full paper width, so combining it with text would overflow the line
	 * by construction rather than by accident.
	 */
	private verifyRuleScope(): void {
		const hasRule = this.directives.some((directive) => directive.kind === "RULE");
		if (hasRule && (this.spans.length > 0 || this.directives.length > 1)) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidRuleScope,
				this.ruleColumn,
				"hr",
				"<hr> fills the paper width and must be alone in its line",
			);
		}
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
