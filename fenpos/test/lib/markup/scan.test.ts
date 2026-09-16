import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Span, scan } from "@/lib/markup/scan";
import { tokenize } from "@/lib/markup/tokenizer";

/** The shared corpus the parity suite runs; reused here as a body of real markup. */
const CASES: { name: string; markup: string }[] = JSON.parse(
	readFileSync(
		path.join(process.cwd(), "..", "agent", "src", "test", "resources", "markup", "parity-cases.json"),
		"utf8",
	),
);

const kinds = (spans: Span[]): string[] => spans.map((span) => span.kind);
const textOf = (source: string, span: Span): string => source.slice(span.from, span.to);

/** The tag names tokenize reports, in order, each marked as opening or closing. */
function strictNames(source: string): string[] {
	try {
		return tokenize(source, null)
			.tokens.filter((token) => token.kind === "open" || token.kind === "close")
			.map((token) => `${token.kind === "close" ? "/" : ""}${(token as { name: string }).name}`);
	} catch {
		return [];
	}
}

/** The tag names scan reports, in the same shape. */
function scannedNames(source: string): string[] {
	return scan(source)
		.filter((span) => span.kind === "tag-name")
		.map((span) => `${span.closing ? "/" : ""}${textOf(source, span)}`);
}

describe("scan", () => {
	it("marks a tag's name, attribute name and value", () => {
		const source = "<align to=center>x</align>";
		const spans = scan(source).filter((span) => span.kind !== "text");

		expect(kinds(spans)).toEqual([
			"tag-punctuation",
			"tag-name",
			"attribute-name",
			"tag-punctuation",
			"attribute-value",
			"tag-punctuation",
			"tag-punctuation",
			"tag-name",
			"tag-punctuation",
		]);
		expect(spans.filter((span) => span.kind === "attribute-value").map((span) => textOf(source, span))).toEqual([
			"center",
		]);
	});

	it("marks an entity and a variable reference", () => {
		const source = "a&amp;b{total}";
		const spans = scan(source);

		expect(spans.filter((span) => span.kind === "entity").map((span) => textOf(source, span))).toEqual(["&amp;"]);
		expect(spans.filter((span) => span.kind === "variable").map((span) => textOf(source, span))).toEqual(["{total}"]);
	});

	it("keeps an unrecognised entity as text", () => {
		const source = "a&nbsp;b";

		expect(scan(source).some((span) => span.kind === "entity")).toBe(false);
	});

	it("marks an unterminated tag as incomplete rather than refusing it", () => {
		const spans = scan("<ali");

		expect(spans.some((span) => span.kind === "tag-name")).toBe(true);
		expect(spans.every((span) => span.kind === "text" || span.complete === false)).toBe(true);
	});

	it("marks an unterminated quoted value as incomplete and stops at end of line", () => {
		const source = '<chart title="a\nb';
		const value = scan(source).find((span) => span.kind === "attribute-value");

		expect(value).toBeDefined();
		expect(textOf(source, value as Span)).toBe("a");
		expect((value as Span).complete).toBe(false);
	});

	it("never throws on any prefix of any case", () => {
		for (const parity of CASES) {
			for (let at = 0; at <= parity.markup.length; at++) {
				const prefix = parity.markup.slice(0, at);
				expect(() => scan(prefix), `${parity.name} truncated at ${at}`).not.toThrow();
			}
		}
	});

	it("agrees with the tokenizer about every tag name in a valid document", () => {
		for (const parity of CASES) {
			const strict = strictNames(parity.markup);
			if (strict.length === 0) {
				continue;
			}
			expect(scannedNames(parity.markup), parity.name).toEqual(strict);
		}
	});

	it("marks a bare value incomplete while its tag is unterminated", () => {
		const spans = scan("<a b=1");

		expect(spans.every((span) => span.complete === false)).toBe(true);
	});

	it("keeps a closed quoted value complete inside an unterminated tag", () => {
		const value = scan('<a b="x"').find((span) => span.kind === "attribute-value");

		expect(value?.complete).toBe(true);
	});

	it("ends a tag at the bracket outside its quoted value", () => {
		const source = '<chart title="a > b">';
		const spans = scan(source);
		const value = spans.find((span) => span.kind === "attribute-value");
		const brackets = spans.filter((span) => span.kind === "tag-punctuation" && source[span.from] === ">");

		expect(value && source.slice(value.from, value.to)).toBe("a > b");
		expect(brackets.map((span) => span.from)).toEqual([source.length - 1]);
	});

	it("ends a tag at its bracket when a bare value contains a quote", () => {
		const source = '<a b=x"y>';
		const brackets = scan(source).filter((span) => span.kind === "tag-punctuation" && source[span.from] === ">");

		expect(brackets.map((span) => span.from)).toEqual([source.length - 1]);
	});
});
