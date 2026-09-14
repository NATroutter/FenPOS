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

	it("reads an open tag with a primary argument", () => {
		const { tokens } = tokenize("<size=2,3>x</size>", null);

		expect(tokens[0]).toEqual({ kind: "open", name: "size", argument: "2,3", attributes: [], line: 1, column: 1 });
		expect(tokens[2]).toEqual({ kind: "close", name: "size", line: 1, column: 12 });
	});

	it("lowercases tag names", () => {
		expect(tokenize("<BOLD>x</Bold>", null).tokens[0]).toMatchObject({ kind: "open", name: "bold" });
		expect(tokenize("<BOLD>x</Bold>", null).tokens[2]).toMatchObject({ kind: "close", name: "bold" });
	});

	it("reads bare and quoted attributes with their columns", () => {
		const { tokens } = tokenize('<chart=bar height=8 title="Sales > 10">', null);

		expect(tokens[0]).toEqual({
			kind: "open",
			name: "chart",
			argument: "bar",
			attributes: [
				{ name: "height", value: "8", column: 12 },
				{ name: "title", value: "Sales > 10", column: 21 },
			],
			line: 1,
			column: 1,
		});
	});

	it("treats a fill argument that is a single quote as the argument, not a quoted value", () => {
		expect(tokenize('<fill=">', null).tokens[0]).toMatchObject({ name: "fill", argument: '"', attributes: [] });
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
		const thrown = refusal("x{v}", context({ v: "a\x1b" }));

		expect(thrown.code).toBe(MARKUP_ERRORS.controlCharacter);
		expect(thrown.column).toBe(2);
		expect(thrown.detail).toBe("v");
	});

	it("does not treat a bare carriage return as a break", () => {
		expect(refusal("a\rb").code).toBe(MARKUP_ERRORS.controlCharacter);
	});

	it("reports the line on every token after a break", () => {
		const { tokens } = tokenize("<bold>\nx\n</bold>", null);

		expect(tokens.map((token) => token.line)).toEqual([1, 1, 2, 2, 3]);
	});
});
