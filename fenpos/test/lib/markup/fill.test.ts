import { describe, expect, it } from "vitest";
import { resolveFills } from "@/lib/markup/fill";
import { lineColumns } from "@/lib/markup/model";
import { parseMarkup } from "@/lib/markup/parser";

/**
 * Behavioural tests for fill resolution.
 *
 * Every expectation is a literal string rather than a computed one. The Java port carries the same
 * table, and a literal is what turns a divergence between the two into a visible mismatch instead
 * of two implementations agreeing on the same wrong arithmetic.
 *
 * 42 columns throughout: the default for 80mm paper, and wide enough that the split of an odd
 * remainder is legible.
 */
describe("resolveFills", () => {
	const COLUMNS = 42;

	/** Parses, resolves, and flattens back to the characters that would print. */
	const filled = (source: string, columns = COLUMNS): string =>
		resolveFills(parseMarkup(source), columns)
			.spans.map((span) => span.text)
			.join("");

	it("pads a two-column row to the paper's width", () => {
		expect(filled("Coffee<fill>2.50")).toBe(`Coffee${" ".repeat(32)}2.50`);
	});

	it("lands the row exactly on the paper's edge", () => {
		expect(lineColumns(resolveFills(parseMarkup("Coffee<fill>2.50"), COLUMNS))).toBe(COLUMNS);
	});

	it("repeats the character the tag named", () => {
		expect(filled("Coffee<fill=.>2.50")).toBe(`Coffee${".".repeat(32)}2.50`);
	});

	it("splits the slack evenly between several fills", () => {
		expect(filled("Qty<fill>Item<fill>Price")).toBe(`Qty${" ".repeat(15)}Item${" ".repeat(15)}Price`);
	});

	it("gives an uneven remainder to the earliest gap", () => {
		expect(filled("Qty<fill>Items<fill>Price")).toBe(`Qty${" ".repeat(15)}Items${" ".repeat(14)}Price`);
	});

	it("still lands on the edge when the remainder is uneven", () => {
		expect(lineColumns(resolveFills(parseMarkup("Qty<fill>Items<fill>Price"), COLUMNS))).toBe(COLUMNS);
	});

	it("emits nothing when the text already fills the paper", () => {
		const text = "x".repeat(42);

		expect(filled(`${text}<fill>`)).toBe(text);
	});

	/**
	 * The documented consequence of collapsing rather than guaranteeing a separator: the halves of
	 * an over-long row meet with nothing between them.
	 *
	 * The label is 39 columns and the amount 5, so the row wants 44 of the paper's 42 — count them
	 * before changing this string. An earlier draft used a 34-column label, which left three columns
	 * of slack and so tested the opposite of what it names.
	 */
	it("emits nothing when the text overruns the paper, jamming the halves together", () => {
		expect(filled("A very long product name that goes here<fill>12.50")).toBe(
			"A very long product name that goes here12.50",
		);
	});

	/**
	 * The boundary the collapse rule does not reach: two columns of slack is still slack, and a
	 * fill given it pads. Guards against a threshold creeping back in — a narrow roll is exactly
	 * where a jammed row is most likely and least noticed.
	 */
	it("pads a single fill given only a few columns of slack", () => {
		expect(filled("Coffee<fill>2.50", 12)).toBe("Coffee  2.50");
	});

	/**
	 * A budget that cannot buy even one character of an enlarged fill. Distinct from having no
	 * slack: there are columns left over, and they stay unspent because the character will not fit.
	 */
	it("emits nothing when the budget is smaller than one fill character", () => {
		const line = resolveFills(parseMarkup("X<size=2>A<fill>B</size>"), 6);

		expect(line.spans.map((span) => span.text).join("")).toBe("XAB");
		expect(lineColumns(line)).toBe(5);
	});

	/**
	 * A fill inside `<size=2>` spends two columns per character, so an odd budget cannot be spent
	 * exactly and the line lands a column short. Under the default multiplier this cannot arise.
	 */
	it("spends a budget in whole characters, leaving the line short under a width multiplier", () => {
		const line = resolveFills(parseMarkup("X<size=2>A<fill>B</size>"), COLUMNS);

		expect(line.spans.map((span) => span.text).join("")).toBe(`XA${" ".repeat(18)}B`);
		expect(lineColumns(line)).toBe(41);
	});

	it("returns a line with no fills untouched", () => {
		const line = parseMarkup("Coffee 2.50");

		expect(resolveFills(line, COLUMNS)).toBe(line);
	});

	it("empties the fills it resolved", () => {
		expect(resolveFills(parseMarkup("a<fill>b"), COLUMNS).fills).toEqual([]);
	});

	it("draws a rule from a fill that is alone on its line", () => {
		expect(filled("<fill=->")).toBe("-".repeat(42));
	});

	it("right-aligns a segment when the fill leads", () => {
		expect(filled("<fill>2.50")).toBe(`${" ".repeat(38)}2.50`);
	});

	it("pads to the edge when the fill trails", () => {
		expect(filled("Total<fill>")).toBe(`Total${" ".repeat(37)}`);
	});

	it("gives the single column of slack to the first fill when there are more fills than columns", () => {
		expect(filled("ab<fill><fill><fill>", 3)).toBe("ab ");
	});
});
