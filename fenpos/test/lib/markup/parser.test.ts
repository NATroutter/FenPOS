import { describe, expect, it, vi } from "vitest";
import { symbolGeometry } from "@/lib/markup/blocks";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import { needsRaster } from "@/lib/markup/flatten";
import { columnAt, isDirectiveOnly, type Line, PLAIN, type Span } from "@/lib/markup/model";
import { parseDocument, parseLine, type VariableContext } from "@/lib/markup/parser";

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
describe("parseLine", () => {
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
			parseLine(source);
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
		const line = parseLine("Coffee 2.50");

		expect(line.spans).toHaveLength(1);
		expect(line.spans[0].text).toBe("Coffee 2.50");
		expect(line.spans[0].style.bold).toBe(false);
		expect(line.align).toBe("LEFT");
	});

	it("parses an empty element as a blank line", () => {
		const line = parseLine("");

		expect(line.spans).toHaveLength(0);
		expect(line.directives).toHaveLength(0);
	});

	it("decodes entities into literal characters", () => {
		expect(plainText(parseLine("a &lt; b &amp; c"))).toBe("a < b & c");
	});

	it("treats an ampersand that starts no entity as literal", () => {
		expect(plainText(parseLine("Fish & Chips 50% &x"))).toBe("Fish & Chips 50% &x");
	});

	it("records where each span started", () => {
		// Spans carry where they started so a later stage can report an exact column. Markup
		// consumes source characters that produce no text, so the offset cannot be recovered
		// from the parsed text alone.
		const line = parseLine("<bold>ab</bold>cd");

		expect(line.spans[0].sourceColumn).toBe(7);
		expect(line.spans[1].sourceColumn).toBe(16);
	});

	it("isolates an entity into its own span so later columns stay exact", () => {
		// An entity occupies more source characters than it produces, so a span containing one
		// could not be measured by simple arithmetic.
		const line = parseLine("a&lt;b");

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
		const line = parseLine("<bold>Total:</bold> 12.30");

		expect(line.spans).toHaveLength(2);
		expect(line.spans[0].text).toBe("Total:");
		expect(line.spans[0].style.bold).toBe(true);
		expect(line.spans[1].text).toBe(" 12.30");
		expect(line.spans[1].style.bold).toBe(false);
	});

	it("applies nested tags cumulatively", () => {
		const style = parseLine("<bold><underline>x</underline></bold>").spans[0].style;

		expect(style.bold).toBe(true);
		expect(style.underline).toBe(1);
	});

	it("parses size arguments as separate multipliers", () => {
		const style = parseLine("<size=2,3>BIG</size>").spans[0].style;

		expect(style.widthMult).toBe(2);
		expect(style.heightMult).toBe(3);
	});

	it("parses a single size argument as both multipliers", () => {
		const style = parseLine("<size=2>BIG</size>").spans[0].style;

		expect(style.widthMult).toBe(2);
		expect(style.heightMult).toBe(2);
	});

	it("parses underline thickness", () => {
		expect(parseLine("<underline=2>x</underline>").spans[0].style.underline).toBe(2);
	});

	it("parses font selection", () => {
		expect(parseLine("<font=b>x</font>").spans[0].style.font).toBe("B");
	});

	it("treats tag names as case insensitive", () => {
		expect(parseLine("<BOLD>x</BOLD>").spans[0].style.bold).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Alignment
	// -----------------------------------------------------------------------

	it("makes alignment a line property rather than a span style", () => {
		const line = parseLine("<align=center>RECEIPT</align>");

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
	// Fills
	// -----------------------------------------------------------------------

	it("records a fill between the spans it separates", () => {
		const line = parseLine("Coffee<fill>2.50");

		expect(line.spans.map((span) => span.text)).toEqual(["Coffee", "2.50"]);
		expect(line.fills).toEqual([{ afterSpans: 1, character: " ", style: PLAIN, sourceColumn: 7 }]);
	});

	it("defaults a fill to a space and takes any other character from the argument", () => {
		expect(parseLine("a<fill>b").fills[0].character).toBe(" ");
		expect(parseLine("a<fill=.>b").fills[0].character).toBe(".");
	});

	/**
	 * An astral character is one character and two UTF-16 units. Counting units would refuse this
	 * as though the caller had written two, so accepting it is what pins the code-point counting.
	 */
	it("accepts a fill character outside the basic plane", () => {
		expect(parseLine("a<fill=🙂>b").fills[0].character).toBe("🙂");
	});

	it("refuses a fill argument that is not exactly one character", () => {
		expect(error("a<fill=ab>b").code).toBe(MARKUP_ERRORS.invalidTagArgument);
		expect(error("a<fill=>b").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("refuses a closing fill tag", () => {
		expect(error("a<fill>b</fill>").code).toBe(MARKUP_ERRORS.unexpectedCloseTag);
	});

	it("captures the style in effect where the fill was written", () => {
		const line = parseLine("<bold>Total<fill=.>5.00</bold>");

		expect(line.fills[0].style.bold).toBe(true);
	});

	it("records several fills in the order they were written", () => {
		const line = parseLine("Qty<fill>Item<fill>Price");

		expect(line.fills.map((fill) => fill.afterSpans)).toEqual([1, 2]);
	});

	/**
	 * A fill produces no span, so the sole-occupant check has to count fills as well or an element
	 * would be free to put a rule and a pad on the same line and print two lines of paper from one.
	 */
	it("refuses a fill sharing an element with a rule", () => {
		const thrown = error("<hr><fill>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidRuleScope);
	});

	it("refuses a fill sharing an element with a symbol", () => {
		expect(error("<qr>abc</qr><fill>").code).toBe(MARKUP_ERRORS.invalidBlockScope);
	});

	it("refuses a fill inside a block", () => {
		expect(error("<qr>a<fill>b</qr>").code).toBe(MARKUP_ERRORS.invalidBlockScope);
	});

	it("refuses a fill after a line-owning tag has closed", () => {
		expect(error("<align=right>x</align><fill>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	/**
	 * A filled line spans the paper, so alignment around one has nothing left to move and the pair
	 * is a no-op. Permitted rather than refused: refusing would mean new parser state to detect a
	 * combination that is harmless, and under a width multiplier the line can land a column short,
	 * where alignment is not even a no-op.
	 */
	it("permits a fill inside an alignment", () => {
		const line = parseLine("<align=center>a<fill>b</align>");

		expect(line.align).toBe("CENTER");
		expect(line.fills).toHaveLength(1);
	});

	// -----------------------------------------------------------------------
	// Directives
	// -----------------------------------------------------------------------

	it("parses a cut as a directive-only line", () => {
		const line = parseLine("<cut>");

		expect(line.spans).toHaveLength(0);
		expect(line.directives).toEqual([{ kind: "CUT", mode: "FULL" }]);
	});

	it("parses a partial cut", () => {
		expect(parseLine("<cut=partial>").directives).toEqual([{ kind: "CUT", mode: "PARTIAL" }]);
	});

	it("parses a feed with its line count", () => {
		expect(parseLine("<feed=3>").directives).toEqual([{ kind: "FEED", lines: 3 }]);
	});

	it("parses a rule alone on its line", () => {
		expect(parseLine("<hr>").directives).toEqual([{ kind: "RULE" }]);
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

	/**
	 * A tag name that is a property of `Object.prototype` is an unknown tag like any other.
	 *
	 * The registry is an object literal, so a bare index found `constructor`, `valueOf`,
	 * `hasOwnProperty` and the rest on the prototype chain. The parser then read `.kind` off a
	 * function, which threw a raw `Error` — a 500 for markup whose only fault was naming a tag that
	 * does not exist. `toString` happened to be refused, because its inherited value is a function
	 * whose `.kind` is undefined and the parser's next check caught that; `constructor` was not.
	 *
	 * Every inherited name is walked, because the ones that behave differently are exactly the ones a
	 * spot check would miss.
	 */
	it("rejects a tag named after an inherited property, as an unknown tag rather than a fault", () => {
		for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
			const thrown = error(`<${name}>`);

			expect(thrown.code, name).toBe(MARKUP_ERRORS.unknownTag);
			expect(thrown.detail, name).toBe(name);
		}
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

	// -----------------------------------------------------------------------
	// Variables
	// -----------------------------------------------------------------------

	describe("variables", () => {
		const context = (entries: Record<string, string>, maxPerElement = 100): VariableContext => ({
			values: new Map(Object.entries(entries)),
			maxPerElement,
		});

		/** Parses with a context and returns the error, failing the test if the parse succeeded. */
		const variableError = (source: string, variables: VariableContext): MarkupError => {
			try {
				parseLine(source, variables);
			} catch (thrown) {
				if (thrown instanceof MarkupError) {
					return thrown;
				}
				throw thrown;
			}
			throw new Error(`expected '${source}' to be rejected`);
		};

		it("substitutes a value", () => {
			const line = parseLine("Call {phone}", context({ phone: "010-1234567" }));

			expect(plainText(line)).toBe("Call 010-1234567");
		});

		it("leaves braces alone when no context is given, which is the feature switched off", () => {
			const line = parseLine("Call {phone}");

			expect(plainText(line)).toBe("Call {phone}");
		});

		it("prints a tag inside a value as characters rather than obeying it", () => {
			const line = parseLine("{store}", context({ store: "<b>FenPOS</b>" }));

			expect(plainText(line)).toBe("<b>FenPOS</b>");
			expect(line.spans.every((span) => span.style.bold === false)).toBe(true);
		});

		it("keeps a substituted value in its own span, carrying the reference's column", () => {
			const line = parseLine("ab{x}cd", context({ x: "VALUE" }));

			const substituted = line.spans.find((span) => span.text === "VALUE");
			expect(substituted).toBeDefined();
			expect(substituted?.sourceColumn).toBe(3);
		});

		it("reports the column of text after a substitution against the source, not the output", () => {
			const line = parseLine("{x}tail", context({ x: "a much longer value" }));

			const tail = line.spans.find((span) => span.text === "tail");
			expect(tail?.sourceColumn).toBe(4);
		});

		it("carries the style the reference was written in", () => {
			const line = parseLine("<bold>{x}</bold>", context({ x: "BOLD" }));

			expect(line.spans[0].text).toBe("BOLD");
			expect(line.spans[0].style.bold).toBe(true);
		});

		it("substitutes inside a block tag, so a QR can carry a configured URL", () => {
			const line = parseLine("<qr>{site}</qr>", context({ site: "https://fenpos.fi" }));

			const qr = line.directives.find((directive) => directive.kind === "QR");
			expect(qr).toMatchObject({ content: "https://fenpos.fi" });
			expect(isDirectiveOnly(line)).toBe(true);
		});

		it("substitutes an image reference", () => {
			const line = parseLine("<image>{brand}</image>", context({ brand: "logo" }));

			expect(line.directives[0]).toMatchObject({ kind: "IMAGE", ref: "logo" });
		});

		it("refuses an unknown name, naming it and its column", () => {
			const fault = variableError("Call {phne}", context({ phone: "010" }));

			expect(fault.code).toBe(MARKUP_ERRORS.unknownVariable);
			expect(fault.column).toBe(6);
			expect(fault.detail).toBe("phne");
		});

		it("leaves text that is not name-shaped alone", () => {
			const line = parseLine("Table {1 of 4}", context({ phone: "010" }));

			expect(plainText(line)).toBe("Table {1 of 4}");
		});

		it("leaves an unclosed brace alone", () => {
			const line = parseLine("50% {off", context({ off: "x" }));

			expect(plainText(line)).toBe("50% {off");
		});

		it("prints a literal reference written with &lbrace;", () => {
			const line = parseLine("&lbrace;phone}", context({ phone: "010-1234567" }));

			expect(plainText(line)).toBe("{phone}");
		});

		it("decodes &lbrace; even with no variable context", () => {
			expect(plainText(parseLine("&lbrace;x}"))).toBe("{x}");
		});

		it("refuses a value carrying a control character, at the reference's column", () => {
			const fault = variableError("ab{bad}", context({ bad: `x${String.fromCharCode(0x1b)}y` }));

			expect(fault.code).toBe(MARKUP_ERRORS.controlCharacter);
			expect(fault.column).toBe(3);
		});

		it("refuses more references in one element than the limit allows", () => {
			const fault = variableError("{x}{x}{x}", context({ x: "a" }, 2));

			expect(fault.code).toBe(MARKUP_ERRORS.tooManyVariableReferences);
		});

		it("counts references against the limit rather than distinct names", () => {
			const line = parseLine("{x}{x}", context({ x: "a" }, 2));

			expect(plainText(line)).toBe("aa");
		});

		/**
		 * Asserted on `spans.length`, not on the joined text.
		 *
		 * `plainText` concatenates every span's text, so an empty span is invisible to it — the
		 * assertion `plainText(line) === "ab"` passes whether or not the guard exists, which made the
		 * test named for this behaviour prove nothing. The span count is what the guard is actually
		 * about, and two checks read it: `verifyBlockScope` and `requireLineOwnerCanOpen` both ask
		 * `spans.length`, not whether the spans hold any characters.
		 */
		it("substitutes an empty value without producing a phantom span", () => {
			const line = parseLine("a{x}b", context({ x: "" }));

			expect(plainText(line)).toBe("ab");
			expect(line.spans).toHaveLength(2);
			expect(line.spans.map((span) => span.text)).toEqual(["a", "b"]);
		});

		/** What the phantom span would cost: a rule beside an empty value stops printing and starts failing. */
		it("lets an empty value share its element with a rule", () => {
			const line = parseLine("{blank}<hr>", context({ blank: "" }));

			expect(line.spans).toHaveLength(0);
			expect(line.directives).toEqual([{ kind: "RULE" }]);
		});

		/**
		 * The column of a character *inside* a substituted value.
		 *
		 * `columnAt` reports the reference's own column for every character of a substituted span,
		 * rather than counting forward from it. The arithmetic that used to run — `sourceColumn +
		 * offset` — is exact for `&amp;`, which turns five source characters into one, but a variable
		 * reverses that ratio: `{x}` is three columns of source and this value is eight characters, so
		 * counting forward reports column 8 for an element three columns long. A position the element
		 * does not have is worse than no position, in an API whose whole promise is that the column
		 * points at the character to fix.
		 */
		it("reports a character inside a substituted value at the reference's column, not past the element", () => {
			const line = parseLine("{x}", context({ x: "Coffee ☕" }));

			const span = line.spans[0];
			expect(span.text).toBe("Coffee ☕");
			expect(span.expandedFrom).toBe("x");
			expect(columnAt(span, 0)).toBe(1);
			expect(columnAt(span, 7)).toBe(1);
		});

		/** Text the author wrote still counts forward, which is what makes the case above a special case. */
		it("still counts forward through a span the author typed", () => {
			const line = parseLine("Coffee", context({}));

			expect(line.spans[0].expandedFrom).toBeUndefined();
			expect(columnAt(line.spans[0], 3)).toBe(4);
		});

		/** An entity produces exactly one character, so offset zero is the only offset and stays exact. */
		it("leaves an entity's column exact, because one token becomes one character", () => {
			const line = parseLine("ab&amp;cd");

			const entity = line.spans.find((span) => span.text === "&");
			expect(entity?.expandedFrom).toBeUndefined();
			expect(columnAt(entity as Span, 0)).toBe(3);
		});
	});
});

describe("wrap tags", () => {
	it("leaves wrap unset when no tag is present", () => {
		expect(parseLine("Yhteensa 14.80").wrap).toBeNull();
	});

	it("reads <nowrap> as a refusal to wrap", () => {
		expect(parseLine("<nowrap>Yhteensa 14.80</nowrap>").wrap).toBe(false);
	});

	it("reads <wrap> as a request to wrap", () => {
		expect(parseLine("<wrap>A large coffee and a cinnamon bun</wrap>").wrap).toBe(true);
	});

	it("keeps the text and drops the tag", () => {
		const line = parseLine("<nowrap>Yhteensa 14.80</nowrap>");

		expect(line.spans.map((span) => span.text).join("")).toBe("Yhteensa 14.80");
	});

	it("nests inside alignment", () => {
		const line = parseLine("<align=right><nowrap>Yhteensa 14.80</nowrap></align>");

		expect(line.align).toBe("RIGHT");
		expect(line.wrap).toBe(false);
	});

	it("nests outside alignment, which means the same thing", () => {
		const line = parseLine("<nowrap><align=right>Yhteensa 14.80</align></nowrap>");

		expect(line.align).toBe("RIGHT");
		expect(line.wrap).toBe(false);
	});

	it("encloses styling tags", () => {
		const line = parseLine("<nowrap><bold>Yhteensa 14.80</bold></nowrap>");

		expect(line.wrap).toBe(false);
		expect(line.spans[0].style.bold).toBe(true);
	});

	it("permits a rule, where wrapping is a no-op", () => {
		const line = parseLine("<nowrap><hr></nowrap>");

		expect(line.wrap).toBe(false);
		expect(line.directives).toEqual([{ kind: "RULE" }]);
	});
});

describe("wrap tag scope", () => {
	/** Runs a parse and returns the error, failing the test if it succeeded. */
	const scopeError = (source: string): MarkupError => {
		try {
			parseLine(source);
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
			parseLine(source);
		} catch (thrown) {
			if (thrown instanceof MarkupError) {
				return thrown;
			}
			throw thrown;
		}
		throw new Error(`expected '${source}' to be rejected`);
	};

	it("parses a QR code with its default size", () => {
		const line = parseLine("<qr>https://example.com/o/1</qr>");

		expect(line.directives).toEqual([
			expect.objectContaining({ kind: "QR", content: "https://example.com/o/1", size: 6 }),
		]);
	});

	it("keeps a QR code out of the spans, so the line stays directive-only", () => {
		const line = parseLine("<qr>https://example.com/o/1</qr>");

		expect(line.spans).toHaveLength(0);
		expect(isDirectiveOnly(line)).toBe(true);
	});

	it("measures a QR code with the same geometry the preview draws", () => {
		const line = parseLine("<qr=6>https://example.com/o/1</qr>");
		const expected = symbolGeometry({ kind: "QR", content: "https://example.com/o/1", size: 6 });

		expect(line.directives[0]).toMatchObject({ heightLines: expected.heightLines });
	});

	it("takes the module size from the argument", () => {
		const line = parseLine("<qr=8>https://example.com/o/1</qr>");

		expect(line.directives[0]).toMatchObject({ kind: "QR", size: 8 });
	});

	it("rejects a module size outside 1-16", () => {
		expect(() => parseLine("<qr=99>x</qr>")).toThrow(/1.*16/);
	});

	it("keeps characters that would otherwise be markup", () => {
		const line = parseLine("<qr>https://example.com/o/1?a=1&amp;b=2</qr>");

		expect(line.directives[0]).toMatchObject({ content: "https://example.com/o/1?a=1&b=2" });
	});

	it("rejects a control character inside a block, same as in text", () => {
		expect(blockError(`<qr>a${String.fromCharCode(0x1b)}b</qr>`).code).toBe(MARKUP_ERRORS.controlCharacter);
	});

	it("refuses markup inside a block, whose content is literal data", () => {
		expect(blockError("<qr><bold>x</bold></qr>").code).toBe(MARKUP_ERRORS.invalidBlockScope);
	});

	it("parses a barcode with its symbology", () => {
		const line = parseLine("<barcode=EAN13>1234567890128</barcode>");

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
		expect(() => parseLine("<barcode=EAN13>123</barcode>")).toThrow(/13/);
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
			parseLine("<qr>https://example.com/o/1</qr>");
		} catch (caught) {
			thrown = caught;
		}

		expect(thrown).toBe(fault);
	});

	it("parses a PDF417 symbol with its default error level", () => {
		const line = parseLine("<pdf417>ORDER-1</pdf417>");

		expect(line.directives[0]).toMatchObject({ kind: "PDF417", content: "ORDER-1", errorLevel: 1 });
	});

	it("takes the PDF417 error level from the argument", () => {
		expect(parseLine("<pdf417=4>ORDER-1</pdf417>").directives[0]).toMatchObject({ errorLevel: 4 });
	});

	it("rejects a PDF417 error level outside 0-8", () => {
		expect(blockError("<pdf417=9>x</pdf417>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("parses a drawer pulse with its default pin", () => {
		const line = parseLine("<drawer>");

		expect(line.directives).toEqual([{ kind: "DRAWER", pin: 2 }]);
	});

	it("parses the second drawer pin", () => {
		expect(parseLine("<drawer=5>").directives[0]).toEqual({ kind: "DRAWER", pin: 5 });
	});

	it("rejects a drawer pin that is neither 2 nor 5", () => {
		expect(blockError("<drawer=3>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("refuses a block sharing its element with text", () => {
		expect(() => parseLine("Order <qr>x</qr>")).toThrow(/alone/);
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
		expect(() => parseLine("Thanks<drawer>")).not.toThrow();
	});

	it("allows a drawer pulse beside a block, since it prints nothing", () => {
		expect(() => parseLine("<qr>x</qr><drawer>")).not.toThrow();
	});

	it("permits a block inside an alignment, which owns the whole line", () => {
		const line = parseLine("<align=center><qr>x</qr></align>");

		expect(line.align).toBe("CENTER");
		expect(line.directives[0]).toMatchObject({ kind: "QR" });
	});
});

/**
 * The image tag, which is a block like the symbols but carries no measurement.
 *
 * Everything asserted here is everything the parser can know. How tall an image prints depends on
 * the device's dot width and on the image's own dimensions, and the second of those is either a
 * database row or an HTTP fetch — so it is settled by the compiler's pre-pass, not here. A test in
 * `compiler.test.ts` pins the height; these pin what reaches it.
 */
describe("the image tag", () => {
	/** Parses and returns the error, failing the test if the parse succeeded. */
	const imageError = (source: string): MarkupError => {
		try {
			parseLine(source);
		} catch (thrown) {
			if (thrown instanceof MarkupError) {
				return thrown;
			}
			throw thrown;
		}
		throw new Error(`expected '${source}' to be rejected`);
	};

	it("takes a stored asset name", () => {
		expect(parseLine("<image>logo</image>").directives[0]).toMatchObject({
			kind: "IMAGE",
			ref: "logo",
			widthPercent: 100,
		});
	});

	it("takes a width percentage", () => {
		expect(parseLine("<image=50>logo</image>").directives[0]).toMatchObject({ widthPercent: 50 });
	});

	it("refuses a percentage outside 1-100", () => {
		expect(imageError("<image=0>logo</image>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
		expect(imageError("<image=101>logo</image>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	/**
	 * The reason the tag is paired rather than `<image=…>`: a URL routinely carries `=` in a query
	 * string, so an argument-shaped reference would be split at the first one.
	 */
	it("keeps a URL with a query string intact", () => {
		expect(parseLine("<image>https://x.test/l.png?v=2</image>").directives[0]).toMatchObject({
			ref: "https://x.test/l.png?v=2",
		});
	});

	/** The other half of that reason: an escaped separator has to survive into the reference. */
	it("decodes an entity inside the reference, so a two-parameter URL survives", () => {
		expect(parseLine("<image>https://x.test/l.png?a=1&amp;b=2</image>").directives[0]).toMatchObject({
			ref: "https://x.test/l.png?a=1&b=2",
		});
	});

	/**
	 * The one content tag that may share its line, because it is the one the layout engine can place
	 * beside text. A `<qr>` still cannot: nothing draws a symbol into a row of glyphs.
	 */
	it("may sit beside text, which makes the line one to draw rather than print", () => {
		expect(() => parseLine("Logo <image>logo</image>")).not.toThrow();
		expect(needsRaster(parseDocument("Logo <image>logo</image>").nodes)).toBe(true);
		expect(imageError("Logo <qr>x</qr>").code).toBe(MARKUP_ERRORS.invalidBlockScope);
	});

	it("keeps the reference out of the spans, so the line stays directive-only", () => {
		const line = parseLine("<image>logo</image>");

		expect(line.spans).toHaveLength(0);
		expect(isDirectiveOnly(line)).toBe(true);
	});

	it("refuses an empty reference", () => {
		expect(imageError("<image></image>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("refuses markup inside it, whose content is a reference rather than text", () => {
		expect(imageError("<image><bold>logo</bold></image>").code).toBe(MARKUP_ERRORS.invalidBlockScope);
	});

	it("carries no height, which only the compiler can know", () => {
		expect(parseLine("<image>logo</image>").directives[0]).not.toHaveProperty("heightLines");
	});

	it("obeys an alignment that owns the line", () => {
		const line = parseLine("<align=center><image=25>logo</image></align>");

		expect(line.align).toBe("CENTER");
		expect(line.directives[0]).toMatchObject({ kind: "IMAGE", ref: "logo", widthPercent: 25 });
	});
});

/**
 * The whole-document entry point, which is what every other case here is one line of.
 *
 * What it adds over {@link parseLine} is the line number: a document has several, and a refusal on
 * the third of them is only worth reading if it says so.
 */
describe("parseDocument", () => {
	it("normalises Windows line endings", () => {
		expect(parseDocument("a\r\nb").lines).toHaveLength(2);
	});

	it("carries the line on an error inside a spanning scope", () => {
		const thrown = (() => {
			try {
				parseDocument("<bold>\n<size=9>x</size>\n</bold>");
			} catch (error) {
				return error as MarkupError;
			}
			throw new Error("expected a refusal");
		})();

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidTagArgument);
		expect(thrown.line).toBe(2);
		expect(thrown.column).toBe(1);
	});

	it("refuses parseLine on a document", () => {
		expect(() => parseLine("a\nb")).toThrow(/one line/);
	});
});
