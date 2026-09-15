import { describe, expect, it } from "vitest";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import type { VariableContext } from "@/lib/markup/parser";
import { type Token, tokenize } from "@/lib/markup/tokenizer";

const context = (entries: Record<string, string>, maxPerElement = 100): VariableContext => ({
	values: new Map(Object.entries(entries)),
	maxPerElement,
});

const kinds = (tokens: Token[]): string[] => tokens.map((token) => token.kind);

const refusal = (source: string, variables: VariableContext | null = null): MarkupError => {
	try {
		tokenize(source, variables);
	} catch (thrown) {
		if (thrown instanceof MarkupError) {
			return thrown;
		}
		throw thrown;
	}
	throw new Error(`expected '${source}' to be refused`);
};

describe("tokenize", () => {
	it("emits one text token for a plain line", () => {
		const { tokens } = tokenize("Coffee 2.50", null);

		expect(tokens).toEqual([{ kind: "text", text: "Coffee 2.50", line: 1, column: 1 }]);
	});

	it("splits lines on newlines and restarts the column", () => {
		const { tokens, lineChars } = tokenize("ab\ncd", null);

		expect(kinds(tokens)).toEqual(["text", "break", "text"]);
		expect(tokens[1]).toEqual({ kind: "break", line: 1, column: 3 });
		expect(tokens[2]).toEqual({ kind: "text", text: "cd", line: 2, column: 1 });
		expect(lineChars).toEqual([2, 2]);
	});

	it("keeps an empty line as a break with nothing around it", () => {
		expect(kinds(tokenize("a\n\nb", null).tokens)).toEqual(["text", "break", "break", "text"]);
		expect(tokenize("a\n\nb", null).lineChars).toEqual([1, 0, 1]);
	});

	/**
	 * Resolving a tag is case-insensitive and `tagByName` lowercases for that itself, so lowercasing
	 * here would only throw away the spelling a refusal wants to echo back at its author.
	 */
	it("keeps a tag name as it was written", () => {
		expect(tokenize("<BOLD>x</Bold>", null).tokens[0]).toMatchObject({ kind: "open", name: "BOLD" });
		expect(tokenize("<BOLD>x</Bold>", null).tokens[2]).toMatchObject({ kind: "close", name: "Bold" });
	});

	it("reads bare and quoted attributes with their columns", () => {
		const { tokens } = tokenize('<chart type=bar height=8 title="Sales > 10">', null);

		expect(tokens[0]).toEqual({
			kind: "open",
			name: "chart",
			attributes: [
				{ name: "type", value: "bar", column: 8 },
				{ name: "height", value: "8", column: 17 },
				{ name: "title", value: "Sales > 10", column: 26 },
			],
			line: 1,
			column: 1,
		});
	});

	it("reads an open tag whose values are all attributes", () => {
		const { tokens } = tokenize("<size width=2 height=3>x</size>", null);

		expect(tokens[0]).toEqual({
			kind: "open",
			name: "size",
			attributes: [
				{ name: "width", value: "2", column: 7 },
				{ name: "height", value: "3", column: 15 },
			],
			line: 1,
			column: 1,
		});
		expect(tokens[2]).toEqual({ kind: "close", name: "size", line: 1, column: 25 });
	});

	it("refuses a value written against the tag name as a malformed attribute", () => {
		const thrown = refusal("<align=center>");

		expect(thrown.code).toBe(MARKUP_ERRORS.unknownAttribute);
		expect(thrown.column).toBe(7);
		expect(thrown.detail).toBe("=");
		expect(thrown.message).toBe("<align> attributes are written key=value");
	});

	it("drops indentation before a tag and keeps the tag's column exact", () => {
		expect(tokenize("  <bold>x</bold>", null).tokens[0]).toEqual({
			kind: "open",
			name: "bold",
			attributes: [],
			line: 1,
			column: 3,
		});
		expect(tokenize("\t<bold>x</bold>", null).tokens[0]).toMatchObject({ kind: "open", column: 2 });
	});

	it("keeps indentation before text", () => {
		expect(tokenize("  - no onion", null).tokens).toEqual([{ kind: "text", text: "  - no onion", line: 1, column: 1 }]);
	});

	it("still refuses a tab before text", () => {
		expect(refusal("\tx").code).toBe(MARKUP_ERRORS.controlCharacter);
	});

	it("drops indentation before a closing tag on a later line", () => {
		const { tokens } = tokenize("<bold>a\n  </bold>", null);

		expect(kinds(tokens)).toEqual(["open", "text", "break", "close"]);
		expect(tokens[3]).toEqual({ kind: "close", name: "bold", line: 2, column: 3 });
	});

	it("counts indentation in the line's raw length", () => {
		expect(tokenize("  <hr>", null).lineChars).toEqual([6]);
	});

	it("refuses an unterminated tag as unknown_tag at its column", () => {
		const thrown = refusal("ab <bold");

		expect(thrown.code).toBe(MARKUP_ERRORS.unknownTag);
		expect(thrown.line).toBe(1);
		expect(thrown.column).toBe(4);
	});

	it("refuses an unterminated quoted value the same way", () => {
		expect(refusal('<box title="open>').code).toBe(MARKUP_ERRORS.unknownTag);
	});

	it("refuses an attribute without a value", () => {
		const thrown = refusal("<box wide>");

		expect(thrown.code).toBe(MARKUP_ERRORS.unknownAttribute);
		expect(thrown.detail).toBe("wide");
		expect(thrown.column).toBe(6);
	});

	it("decodes the three entities into their own tokens", () => {
		const { tokens } = tokenize("a&lt;b&amp;c&lbrace;", null);

		expect(tokens.map((token) => (token.kind === "text" ? token.text : token.kind))).toEqual([
			"a",
			"<",
			"b",
			"&",
			"c",
			"{",
		]);
		expect(tokens[1]).toMatchObject({ column: 2 });
		expect(tokens[3]).toMatchObject({ column: 7 });
	});

	it("leaves any other ampersand as text", () => {
		expect(tokenize("Tom & Jerry", null).tokens).toEqual([{ kind: "text", text: "Tom & Jerry", line: 1, column: 1 }]);
	});

	it("decodes the quote entity in text as a token of its own", () => {
		expect(tokenize("a&quot;b", null).tokens).toEqual([
			{ kind: "text", text: "a", line: 1, column: 1 },
			{ kind: "text", text: '"', line: 1, column: 2 },
			{ kind: "text", text: "b", line: 1, column: 8 },
		]);
	});

	it("decodes entities inside bare and quoted attribute values", () => {
		const { tokens } = tokenize('<x title="He said &quot;hi&quot;" char=&amp; other=&lt;>', null);

		expect(tokens[0]).toEqual({
			kind: "open",
			name: "x",
			attributes: [
				{ name: "title", value: 'He said "hi"', column: 4 },
				{ name: "char", value: "&", column: 35 },
				{ name: "other", value: "<", column: 46 },
			],
			line: 1,
			column: 1,
		});
	});

	it("keeps an ampersand that starts no entity inside a value", () => {
		expect(tokenize("<x a=R&D>", null).tokens[0]).toMatchObject({
			attributes: [{ name: "a", value: "R&D", column: 4 }],
		});
	});

	it("reads a raw quote inside a bare value as part of the value", () => {
		expect(tokenize('<fill char=a">', null).tokens[0]).toMatchObject({
			attributes: [{ name: "char", value: 'a"', column: 7 }],
		});
	});

	it("substitutes a variable into its own token and never re-scans the value", () => {
		const { tokens } = tokenize("Order {id}", context({ id: "<bold>7</bold>" }));

		expect(tokens).toEqual([
			{ kind: "text", text: "Order ", line: 1, column: 1 },
			{ kind: "text", text: "<bold>7</bold>", line: 1, column: 7, expandedFrom: "id" },
		]);
	});

	it("emits nothing for an empty variable value", () => {
		expect(
			tokenize("a{x}b", context({ x: "" })).tokens.map((token) => (token.kind === "text" ? token.text : "")),
		).toEqual(["a", "b"]);
	});

	it("refuses an unknown variable at its column", () => {
		const thrown = refusal("Hi {nobody}", context({}));

		expect(thrown.code).toBe(MARKUP_ERRORS.unknownVariable);
		expect(thrown.column).toBe(4);
		expect(thrown.detail).toBe("nobody");
	});

	it("leaves braces alone when no variables are configured", () => {
		expect(tokenize("{x}", null).tokens).toEqual([{ kind: "text", text: "{x}", line: 1, column: 1 }]);
	});

	it("counts variable references per line", () => {
		expect(() => tokenize("{a}{a}\n{a}{a}", context({ a: "1" }, 2))).not.toThrow();
		expect(refusal("{a}{a}{a}", context({ a: "1" }, 2)).code).toBe(MARKUP_ERRORS.tooManyVariableReferences);
	});

	it("refuses a control character in text with its code point", () => {
		const thrown = refusal("ab\x1bc");

		expect(thrown.code).toBe(MARKUP_ERRORS.controlCharacter);
		expect(thrown.column).toBe(3);
		expect(thrown.detail).toBe("U+001B");
	});

	it("refuses a control character in a variable value at the reference", () => {
		const thrown = refusal("x{v}", context({ v: "a\x07" }));

		expect(thrown.code).toBe(MARKUP_ERRORS.controlCharacter);
		expect(thrown.column).toBe(2);
		expect(thrown.detail).toBe("v");
	});

	it("does not treat a bare carriage return as a break", () => {
		expect(refusal("a\rb").code).toBe(MARKUP_ERRORS.controlCharacter);
	});

	it("refuses a control character in a bare attribute value", () => {
		const thrown = refusal("<box wide=ab\x07>");

		expect(thrown.code).toBe(MARKUP_ERRORS.controlCharacter);
		expect(thrown.detail).toBe("wide");
		expect(thrown.column).toBe(6);
	});

	it("refuses a control character in a quoted attribute value", () => {
		const thrown = refusal('<box title="ab\x07">');

		expect(thrown.code).toBe(MARKUP_ERRORS.controlCharacter);
		expect(thrown.detail).toBe("title");
		expect(thrown.column).toBe(6);
	});

	it("reports the line on every token after a break", () => {
		const { tokens } = tokenize("<bold>\nx\n</bold>", null);

		expect(tokens.map((token) => token.line)).toEqual([1, 1, 2, 2, 3]);
	});
});
