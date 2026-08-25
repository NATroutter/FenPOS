import { describe, expect, it } from "vitest";
import type { Line } from "@/lib/markup/model";
import { parseMarkup } from "@/lib/markup/parser";
import { wrapLine } from "@/lib/markup/wrapper";

/**
 * Behavioural tests for the line wrapper.
 *
 * Translated case for case from `LineWrapperTest.java`. Widths here are deliberately small so
 * the expected break points can be read off the input by eye rather than counted.
 */
describe("wrapLine", () => {
	const plainText = (line: Line): string => line.spans.map((span) => span.text).join("");
	const wrap = (markup: string, columns: number): Line[] => wrapLine(parseMarkup(markup), columns);
	const texts = (lines: Line[]): string[] => lines.map(plainText);

	it("leaves a line that fits untouched", () => {
		const wrapped = wrap("Coffee 2.50", 32);

		expect(wrapped).toHaveLength(1);
		expect(plainText(wrapped[0])).toBe("Coffee 2.50");
	});

	it("breaks at the space before exceeding the width", () => {
		expect(texts(wrap("aaa bbb ccc", 7))).toEqual(["aaa bbb", "ccc"]);
	});

	it("drops the space at the break point", () => {
		expect(texts(wrap("aaaa bbbb", 4))).toEqual(["aaaa", "bbbb"]);
	});

	it("hard breaks a word longer than the width", () => {
		expect(texts(wrap("aaaaaaaaaa", 4))).toEqual(["aaaa", "aaaa", "aa"]);
	});

	it("drops leading whitespace on a continuation", () => {
		expect(texts(wrap("aaaa      bbbb", 4))).toEqual(["aaaa", "bbbb"]);
	});

	it("wraps double-width text at half the columns", () => {
		// The reason wrapping walks spans rather than a plain string: a double-width character
		// occupies two columns, so the same text wraps at half the paper width.
		expect(texts(wrap("<size=2>HELLO WORLD</size>", 20))).toEqual(["HELLO", "WORLD"]);
	});

	it("does not wrap single-width text of the same length at that width", () => {
		expect(texts(wrap("HELLO WORLD", 20))).toEqual(["HELLO WORLD"]);
	});

	it("preserves style across a break", () => {
		const wrapped = wrap("<bold>aaaa bbbb</bold>", 4);

		expect(wrapped).toHaveLength(2);
		expect(wrapped[0].spans[0].style.bold).toBe(true);
		expect(wrapped[1].spans[0].style.bold).toBe(true);
	});

	it("keeps a style boundary that falls inside a fragment", () => {
		const wrapped = wrap("<bold>ab</bold>cd ef", 4);

		expect(texts(wrapped)).toEqual(["abcd", "ef"]);
		expect(wrapped[0].spans).toHaveLength(2);
		expect(wrapped[0].spans[0].style.bold).toBe(true);
		expect(wrapped[0].spans[1].style.bold).toBe(false);
	});

	it("merges neighbouring text of equal style into one span", () => {
		const wrapped = wrap("a&lt;b", 32);

		expect(wrapped).toHaveLength(1);
		expect(wrapped[0].spans, "equal styles should collapse").toHaveLength(1);
		expect(plainText(wrapped[0])).toBe("a<b");
	});

	it("gives every fragment the line alignment", () => {
		const wrapped = wrap("<align=center>aaaa bbbb</align>", 4);

		expect(wrapped).toHaveLength(2);
		for (const line of wrapped) {
			expect(line.align).toBe("CENTER");
		}
	});

	it("attaches directives to the last fragment only", () => {
		// A cut must happen once, after the last fragment. Repeating it per fragment would cut
		// the paper in the middle of the receipt.
		const wrapped = wrap("aaaa bbbb<feed=2>", 4);

		expect(wrapped).toHaveLength(2);
		expect(wrapped[0].directives).toHaveLength(0);
		expect(wrapped[1].directives).toHaveLength(1);
	});

	it("passes through a directive-only line", () => {
		const source = parseMarkup("<cut>");
		const wrapped = wrapLine(source, 32);

		expect(wrapped).toHaveLength(1);
		expect(wrapped[0]).toBe(source);
	});

	it("passes through an empty line", () => {
		const source = parseMarkup("");
		const wrapped = wrapLine(source, 32);

		expect(wrapped).toHaveLength(1);
		expect(wrapped[0]).toBe(source);
	});

	it("emits a character that is wider than the whole line", () => {
		// Guards the wrapping loop: a character wider than the whole paper must still be
		// emitted, or the wrapper would make no progress and spin forever.
		expect(texts(wrap("<size=8>ab</size>", 4))).toEqual(["a", "b"]);
	});

	it("collapses a line of only spaces to nothing", () => {
		const wrapped = wrap("     ", 4);

		expect(wrapped).toHaveLength(1);
		expect(plainText(wrapped[0])).toBe("");
	});

	it("refuses a width below one", () => {
		expect(() => wrap("x", 0)).toThrow(RangeError);
	});
});
