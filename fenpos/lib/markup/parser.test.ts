import { describe, expect, it } from "vitest";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import type { Line } from "@/lib/markup/model";
import { parseMarkup } from "@/lib/markup/parser";

/**
 * Behavioural tests for the markup parser.
 *
 * Translated case for case from `MarkupParserTest.java`, which is the specification for this
 * port. Keeping them in step is the only thing that proves the server now rejects exactly what
 * the agent used to reject — a difference either way is a request that behaves differently after
 * an upgrade for no reason a caller could discover.
 *
 * Error tests assert the reported column as well as the error kind, because the column is the
 * part clients actually use to point a user at their mistake, and it is the part most easily
 * broken by a refactor.
 */
describe("parseMarkup", () => {
	/**
	 * Text carrying a raw ESC at column 3. Built from a char code rather than a literal so the
	 * control byte stays visible to anyone reading this file.
	 */
	const ESCAPE_IN_TEXT = `ab${String.fromCharCode(0x1b)}c`;

	/** Flattens a line back to the characters that would print. */
	const plainText = (line: Line): string => line.spans.map((span) => span.text).join("");

	/** Parses and returns the error, failing the test if the parse succeeded. */
	const error = (source: string): MarkupError => {
		try {
			parseMarkup(source);
		} catch (thrown) {
			if (thrown instanceof MarkupError) {
				return thrown;
			}
			throw thrown;
		}
		throw new Error(`expected '${source}' to be rejected`);
	};

	// -----------------------------------------------------------------------
	// Text and entities
	// -----------------------------------------------------------------------

	it("parses plain text as one unstyled span", () => {
		const line = parseMarkup("Kahvi 2.50");

		expect(line.spans).toHaveLength(1);
		expect(line.spans[0].text).toBe("Kahvi 2.50");
		expect(line.spans[0].style.bold).toBe(false);
		expect(line.align).toBe("LEFT");
	});

	it("parses an empty element as a blank line", () => {
		const line = parseMarkup("");

		expect(line.spans).toHaveLength(0);
		expect(line.directives).toHaveLength(0);
	});

	it("decodes entities into literal characters", () => {
		expect(plainText(parseMarkup("a &lt; b &amp; c"))).toBe("a < b & c");
	});

	it("treats an ampersand that starts no entity as literal", () => {
		expect(plainText(parseMarkup("Fish & Chips 50% &x"))).toBe("Fish & Chips 50% &x");
	});

	it("records where each span started", () => {
		// Spans carry where they started so a later stage can report an exact column. Markup
		// consumes source characters that produce no text, so the offset cannot be recovered
		// from the parsed text alone.
		const line = parseMarkup("<bold>ab</bold>cd");

		expect(line.spans[0].sourceColumn).toBe(7);
		expect(line.spans[1].sourceColumn).toBe(16);
	});

	it("isolates an entity into its own span so later columns stay exact", () => {
		// An entity occupies more source characters than it produces, so a span containing one
		// could not be measured by simple arithmetic.
		const line = parseMarkup("a&lt;b");

		expect(line.spans).toHaveLength(3);
		expect(line.spans[0].sourceColumn).toBe(1);
		expect(line.spans[1].sourceColumn).toBe(2);
		expect(line.spans[2].sourceColumn).toBe(6);
		expect(plainText(line)).toBe("a<b");
	});

	// -----------------------------------------------------------------------
	// Styling
	// -----------------------------------------------------------------------

	it("applies bold to enclosed text only", () => {
		const line = parseMarkup("<bold>Total:</bold> 12.30");

		expect(line.spans).toHaveLength(2);
		expect(line.spans[0].text).toBe("Total:");
		expect(line.spans[0].style.bold).toBe(true);
		expect(line.spans[1].text).toBe(" 12.30");
		expect(line.spans[1].style.bold).toBe(false);
	});

	it("applies nested tags cumulatively", () => {
		const style = parseMarkup("<bold><underline>x</underline></bold>").spans[0].style;

		expect(style.bold).toBe(true);
		expect(style.underline).toBe(1);
	});

	it("parses size arguments as separate multipliers", () => {
		const style = parseMarkup("<size=2,3>BIG</size>").spans[0].style;

		expect(style.widthMult).toBe(2);
		expect(style.heightMult).toBe(3);
	});

	it("parses a single size argument as both multipliers", () => {
		const style = parseMarkup("<size=2>BIG</size>").spans[0].style;

		expect(style.widthMult).toBe(2);
		expect(style.heightMult).toBe(2);
	});

	it("parses underline thickness", () => {
		expect(parseMarkup("<underline=2>x</underline>").spans[0].style.underline).toBe(2);
	});

	it("parses font selection", () => {
		expect(parseMarkup("<font=b>x</font>").spans[0].style.font).toBe("B");
	});

	it("treats tag names as case insensitive", () => {
		expect(parseMarkup("<BOLD>x</BOLD>").spans[0].style.bold).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Alignment
	// -----------------------------------------------------------------------

	it("makes alignment a line property rather than a span style", () => {
		const line = parseMarkup("<align=center>RECEIPT</align>");

		expect(line.align).toBe("CENTER");
		expect(plainText(line)).toBe("RECEIPT");
	});

	it("rejects alignment that does not enclose the whole line", () => {
		expect(error("<align=center>x</align> trailing").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("rejects a second alignment tag", () => {
		expect(error("<align=left><align=right>x</align></align>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	// -----------------------------------------------------------------------
	// Directives
	// -----------------------------------------------------------------------

	it("parses a cut as a directive-only line", () => {
		const line = parseMarkup("<cut>");

		expect(line.spans).toHaveLength(0);
		expect(line.directives).toEqual([{ kind: "CUT", mode: "FULL" }]);
	});

	it("parses a partial cut", () => {
		expect(parseMarkup("<cut=partial>").directives).toEqual([{ kind: "CUT", mode: "PARTIAL" }]);
	});

	it("parses a feed with its line count", () => {
		expect(parseMarkup("<feed=3>").directives).toEqual([{ kind: "FEED", lines: 3 }]);
	});

	it("parses a rule alone on its line", () => {
		expect(parseMarkup("<hr>").directives).toEqual([{ kind: "RULE" }]);
	});

	it("rejects a rule sharing a line with text", () => {
		expect(error("Total <hr>").code).toBe(MARKUP_ERRORS.invalidRuleScope);
	});

	it("refuses to close a void tag", () => {
		expect(error("<cut></cut>").code).toBe(MARKUP_ERRORS.unexpectedCloseTag);
	});

	// -----------------------------------------------------------------------
	// Errors
	// -----------------------------------------------------------------------

	it("rejects an unknown tag at its own column", () => {
		const thrown = error("ab <blink>x</blink>");

		expect(thrown.code).toBe(MARKUP_ERRORS.unknownTag);
		expect(thrown.column).toBe(4);
		expect(thrown.detail).toBe("blink");
	});

	it("rejects an unclosed tag at the opening column", () => {
		const thrown = error("Total: <bold>12.30");

		expect(thrown.code).toBe(MARKUP_ERRORS.unclosedTag);
		expect(thrown.column).toBe(8);
		expect(thrown.detail).toBe("bold");
	});

	it("rejects a closing tag with no matching open", () => {
		const thrown = error("x</bold>");

		expect(thrown.code).toBe(MARKUP_ERRORS.unexpectedCloseTag);
		expect(thrown.column).toBe(2);
	});

	it("rejects overlapping tags", () => {
		expect(error("<bold><underline>x</bold></underline>").code).toBe(MARKUP_ERRORS.unexpectedCloseTag);
	});

	it("rejects a size multiplier above eight", () => {
		expect(error("<size=9,1>x</size>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("rejects a non-numeric size argument", () => {
		expect(error("<size=big>x</size>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("rejects an argument on a tag that takes none", () => {
		expect(error("<bold=1>x</bold>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("rejects a missing argument on a tag that requires one", () => {
		expect(error("<align>x</align>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("rejects an unterminated tag", () => {
		expect(error("<bold x").code).toBe(MARKUP_ERRORS.unknownTag);
	});

	it("rejects control characters at their column", () => {
		// A raw ESC byte is what markup exists to replace. Letting one through would let a
		// caller desynchronise the printer, which is precisely what the grammar prevents.
		const thrown = error(ESCAPE_IN_TEXT);

		expect(thrown.code).toBe(MARKUP_ERRORS.controlCharacter);
		expect(thrown.column).toBe(3);
	});

	it("rejects a tab as a control character", () => {
		expect(error("a\tb").code).toBe(MARKUP_ERRORS.controlCharacter);
	});

	it("rejects delete and C1 controls", () => {
		expect(error(`a${String.fromCharCode(0x7f)}b`).code).toBe(MARKUP_ERRORS.controlCharacter);
		expect(error(`a${String.fromCharCode(0x85)}b`).code).toBe(MARKUP_ERRORS.controlCharacter);
	});
});

describe("wrap tags", () => {
	it("leaves wrap unset when no tag is present", () => {
		expect(parseMarkup("Yhteensa 14.80").wrap).toBeNull();
	});

	it("reads <nowrap> as a refusal to wrap", () => {
		expect(parseMarkup("<nowrap>Yhteensa 14.80</nowrap>").wrap).toBe(false);
	});

	it("reads <wrap> as a request to wrap", () => {
		expect(parseMarkup("<wrap>Iso kahvi ja korvapuusti</wrap>").wrap).toBe(true);
	});

	it("keeps the text and drops the tag", () => {
		const line = parseMarkup("<nowrap>Yhteensa 14.80</nowrap>");

		expect(line.spans.map((span) => span.text).join("")).toBe("Yhteensa 14.80");
	});

	it("nests inside alignment", () => {
		const line = parseMarkup("<align=right><nowrap>Yhteensa 14.80</nowrap></align>");

		expect(line.align).toBe("RIGHT");
		expect(line.wrap).toBe(false);
	});

	it("nests outside alignment, which means the same thing", () => {
		const line = parseMarkup("<nowrap><align=right>Yhteensa 14.80</align></nowrap>");

		expect(line.align).toBe("RIGHT");
		expect(line.wrap).toBe(false);
	});

	it("encloses styling tags", () => {
		const line = parseMarkup("<nowrap><bold>Yhteensa 14.80</bold></nowrap>");

		expect(line.wrap).toBe(false);
		expect(line.spans[0].style.bold).toBe(true);
	});

	it("permits a rule, where wrapping is a no-op", () => {
		const line = parseMarkup("<nowrap><hr></nowrap>");

		expect(line.wrap).toBe(false);
		expect(line.directives).toEqual([{ kind: "RULE" }]);
	});
});

describe("wrap tag scope", () => {
	/** Runs a parse and returns the error, failing the test if it succeeded. */
	const scopeError = (source: string): MarkupError => {
		try {
			parseMarkup(source);
		} catch (thrown) {
			if (thrown instanceof MarkupError) {
				return thrown;
			}
			throw thrown;
		}
		throw new Error("expected the parse to be refused");
	};

	it("refuses text before the tag", () => {
		expect(scopeError("Total: <nowrap>14.80</nowrap>").code).toBe("invalid_wrap_scope");
	});

	it("refuses text after the tag", () => {
		expect(scopeError("<nowrap>14.80</nowrap> paid").code).toBe("invalid_wrap_scope");
	});

	it("refuses a second wrap tag", () => {
		expect(scopeError("<nowrap>a</nowrap><nowrap>b</nowrap>").code).toBe("invalid_wrap_scope");
	});

	it("refuses a line that both wraps and does not", () => {
		expect(scopeError("<wrap><nowrap>x</nowrap></wrap>").code).toBe("invalid_wrap_scope");
	});

	it("refuses a wrap tag inside a styling tag", () => {
		expect(scopeError("<bold><nowrap>x</nowrap></bold>").code).toBe("invalid_wrap_scope");
	});

	it("refuses </nowrap> closing an open <wrap>", () => {
		expect(scopeError("<wrap>x</nowrap>").code).toBe("unexpected_close_tag");
	});

	it("reports the column of the offending tag", () => {
		expect(scopeError("Total: <nowrap>14.80</nowrap>").column).toBe(8);
	});
});
