import { describe, expect, it, vi } from "vitest";
import { symbolGeometry } from "@/lib/markup/blocks";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import { isDirectiveOnly, type Line } from "@/lib/markup/model";
import { parseMarkup } from "@/lib/markup/parser";

/**
 * Leaves `symbolGeometry` real for every test but one.
 *
 * The exception pins that the parser rethrows a fault raised while measuring instead of
 * reporting it to the caller as bad content. Nothing a caller can write triggers such a fault —
 * that is what makes it a fault — so it has to be injected, and this is the narrowest way to do
 * it: the spy delegates to the real implementation unless a single test says otherwise.
 */
vi.mock("@/lib/markup/blocks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/markup/blocks")>();
	return { ...actual, symbolGeometry: vi.fn(actual.symbolGeometry) };
});

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

	/**
	 * Deliberate, not incidental: the line-owning rule that governs <wrap>/<nowrap> also governs
	 * <align>, so a line-owning tag opened inside a styling tag is refused regardless of which
	 * one it is. See "Changes by component" in the wrap-tags design spec.
	 */
	it("rejects alignment opened inside a styling tag, same as wrap", () => {
		expect(error("<bold><align=right>x</align></bold>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
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

/**
 * Block tags: the symbologies and the drawer pulse.
 *
 * These have no counterpart in `MarkupParserTest.java` — the agent's parser was frozen before
 * they existed, and the server is now the only side that parses markup. The invariant these
 * tests exist to protect is that a block's content reaches the directive and never the spans:
 * the compiler's line budget counts a block as `heightLines` of paper rather than as text, and
 * it can only do that if `isDirectiveOnly` still holds for a line carrying one.
 */
describe("block tags", () => {
	/** Parses and returns the error, failing the test if the parse succeeded. */
	const blockError = (source: string): MarkupError => {
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

	it("parses a QR code with its default size", () => {
		const line = parseMarkup("<qr>https://example.com/o/1</qr>");

		expect(line.directives).toEqual([
			expect.objectContaining({ kind: "QR", content: "https://example.com/o/1", size: 6 }),
		]);
	});

	it("keeps a QR code out of the spans, so the line stays directive-only", () => {
		const line = parseMarkup("<qr>https://example.com/o/1</qr>");

		expect(line.spans).toHaveLength(0);
		expect(isDirectiveOnly(line)).toBe(true);
	});

	it("measures a QR code with the same geometry the preview draws", () => {
		const line = parseMarkup("<qr=6>https://example.com/o/1</qr>");
		const expected = symbolGeometry({ kind: "QR", content: "https://example.com/o/1", size: 6 });

		expect(line.directives[0]).toMatchObject({ heightLines: expected.heightLines });
	});

	it("takes the module size from the argument", () => {
		const line = parseMarkup("<qr=8>https://example.com/o/1</qr>");

		expect(line.directives[0]).toMatchObject({ kind: "QR", size: 8 });
	});

	it("rejects a module size outside 1-16", () => {
		expect(() => parseMarkup("<qr=99>x</qr>")).toThrow(/1.*16/);
	});

	it("keeps characters that would otherwise be markup", () => {
		const line = parseMarkup("<qr>https://example.com/o/1?a=1&amp;b=2</qr>");

		expect(line.directives[0]).toMatchObject({ content: "https://example.com/o/1?a=1&b=2" });
	});

	it("rejects a control character inside a block, same as in text", () => {
		expect(blockError(`<qr>a${String.fromCharCode(0x1b)}b</qr>`).code).toBe(MARKUP_ERRORS.controlCharacter);
	});

	it("refuses markup inside a block, whose content is literal data", () => {
		expect(blockError("<qr><bold>x</bold></qr>").code).toBe(MARKUP_ERRORS.invalidBlockScope);
	});

	it("parses a barcode with its symbology", () => {
		const line = parseMarkup("<barcode=EAN13>1234567890128</barcode>");

		expect(line.directives[0]).toMatchObject({
			kind: "BARCODE",
			system: "EAN13",
			content: "1234567890128",
		});
	});

	it("requires a symbology on a barcode", () => {
		expect(blockError("<barcode>123</barcode>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("rejects an unknown symbology", () => {
		expect(blockError("<barcode=NOPE>123</barcode>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("rejects content the symbology cannot encode, at the right column", () => {
		expect(() => parseMarkup("<barcode=EAN13>123</barcode>")).toThrow(/13/);
		expect(blockError("<align=center><barcode=EAN13>123</barcode></align>").column).toBe(15);
	});

	/**
	 * A check digit is arithmetic, not format, so `validateSymbolContent` deliberately does not
	 * test it and the encoder is the one that refuses. That refusal still has to reach the caller
	 * as a 400 naming the column rather than as an unhandled fault.
	 */
	it("rejects content the encoder refuses, as a markup error rather than a crash", () => {
		const thrown = blockError("<barcode=EAN13>1234567890123</barcode>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidTagArgument);
		expect(thrown.column).toBe(1);
		expect(thrown.message).toContain("check digit");
	});

	/**
	 * bwip-js stamps its refusals with an internal identifier — `bwipp.ean13badCheckDigit#6915:` —
	 * that moves with every release of the library. It has no meaning to a caller and no business
	 * in a response they read, so `blocks.ts` strips it before the parser ever sees it.
	 */
	it("keeps the encoder's internal identifier out of the message", () => {
		const thrown = blockError("<barcode=EAN13>1234567890123</barcode>");

		expect(thrown.message).not.toContain("bwipp.");
		expect(thrown.message).not.toMatch(/#\d+/);
	});

	/**
	 * The counterpart to the test above: only the encoder refusing *this content* is a client
	 * mistake. A fault raised while measuring is a defect on this side, and dressing it up as a
	 * 400 would blame the caller for it and hide it from the error rate meant to surface it.
	 */
	it("lets a fault raised while measuring propagate, rather than blaming the content", () => {
		const fault = new TypeError("bwip is not a function");
		vi.mocked(symbolGeometry).mockImplementationOnce(() => {
			throw fault;
		});

		let thrown: unknown;
		try {
			parseMarkup("<qr>https://example.com/o/1</qr>");
		} catch (caught) {
			thrown = caught;
		}

		expect(thrown).toBe(fault);
	});

	it("parses a PDF417 symbol with its default error level", () => {
		const line = parseMarkup("<pdf417>ORDER-1</pdf417>");

		expect(line.directives[0]).toMatchObject({ kind: "PDF417", content: "ORDER-1", errorLevel: 1 });
	});

	it("takes the PDF417 error level from the argument", () => {
		expect(parseMarkup("<pdf417=4>ORDER-1</pdf417>").directives[0]).toMatchObject({ errorLevel: 4 });
	});

	it("rejects a PDF417 error level outside 0-8", () => {
		expect(blockError("<pdf417=9>x</pdf417>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("parses a drawer pulse with its default pin", () => {
		const line = parseMarkup("<drawer>");

		expect(line.directives).toEqual([{ kind: "DRAWER", pin: 2 }]);
	});

	it("parses the second drawer pin", () => {
		expect(parseMarkup("<drawer=5>").directives[0]).toEqual({ kind: "DRAWER", pin: 5 });
	});

	it("rejects a drawer pin that is neither 2 nor 5", () => {
		expect(blockError("<drawer=3>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("refuses a block sharing its element with text", () => {
		expect(() => parseMarkup("Order <qr>x</qr>")).toThrow(/alone/);
	});

	it("reports the block's own column when it shares its element", () => {
		const thrown = blockError("Order <qr>x</qr>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidBlockScope);
		expect(thrown.column).toBe(7);
	});

	it("refuses two blocks in one element", () => {
		expect(blockError("<qr>a</qr><qr>b</qr>").code).toBe(MARKUP_ERRORS.invalidBlockScope);
	});

	it("allows a drawer pulse beside text, since it prints nothing", () => {
		expect(() => parseMarkup("Thanks<drawer>")).not.toThrow();
	});

	it("allows a drawer pulse beside a block, since it prints nothing", () => {
		expect(() => parseMarkup("<qr>x</qr><drawer>")).not.toThrow();
	});

	it("permits a block inside an alignment, which owns the whole line", () => {
		const line = parseMarkup("<align=center><qr>x</qr></align>");

		expect(line.align).toBe("CENTER");
		expect(line.directives[0]).toMatchObject({ kind: "QR" });
	});
});
