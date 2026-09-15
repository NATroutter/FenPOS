import { describe, expect, it } from "vitest";
import { markupEdit } from "@/lib/markup/editing";
import { parseDocument } from "@/lib/markup/parser";

/**
 * The toolbar's edit rules.
 *
 * These assertions are about where the caret ends up as much as what gets written: the text is the
 * obvious half, and the half that goes unnoticed until someone types the next character into the
 * wrong place.
 */
describe("markupEdit", () => {
	it("wraps a selection and keeps it selected, so a second button styles the same words", () => {
		const edit = markupEdit("bold", "TOTAL");

		expect(edit?.insert).toBe("<bold>TOTAL</bold>");
		expect(edit?.insert.slice(edit.selectionFrom, edit.selectionTo)).toBe("TOTAL");
	});

	it("puts the caret between the halves when nothing is selected", () => {
		const edit = markupEdit("bold", "");

		expect(edit?.insert).toBe("<bold></bold>");
		expect(edit?.selectionFrom).toBe("<bold>".length);
		expect(edit?.selectionTo).toBe(edit?.selectionFrom);
	});

	it("writes the argument into the opening tag", () => {
		expect(markupEdit("size", "BIG", "2,2")?.insert).toBe("<size=2,2>BIG</size>");
		expect(markupEdit("align", "", "center")?.insert).toBe("<align=center></align>");
	});

	it("omits an empty argument rather than writing a bare =", () => {
		expect(markupEdit("underline", "x", "")?.insert).toBe("<underline>x</underline>");
	});

	it("keeps the selected text when a void tag is pressed, rather than replacing it", () => {
		// The failure this pins is silent data loss: a void tag encloses nothing, so replacing the
		// selection the way a paired tag does would delete what the person had highlighted.
		const edit = markupEdit("hr", "Thank you");

		expect(edit?.insert).toBe("Thank you<hr>");
		expect(edit?.selectionFrom).toBe(edit?.insert.length);
	});

	it("leaves the caret after a void tag inserted at a bare cursor", () => {
		const edit = markupEdit("feed", "", "3");

		expect(edit?.insert).toBe("<feed=3>");
		expect(edit?.selectionFrom).toBe("<feed=3>".length);
	});

	it("reports an unknown tag rather than inventing one", () => {
		expect(markupEdit("blink", "x")).toBeUndefined();
	});

	it("wraps a selection in a box on its own lines", () => {
		expect(markupEdit("box", "Title")).toEqual({ insert: "<box>\nTitle\n</box>", selectionFrom: 6, selectionTo: 11 });
	});

	it("inserts a table skeleton when nothing is selected", () => {
		expect(markupEdit("table", "")?.insert).toBe("<table>\n<row><cell></cell><cell></cell></row>\n</table>");
	});

	it("ignores a selection when inserting a table, since there is nothing in it to carry over", () => {
		expect(markupEdit("table", "some text")?.insert).toBe("<table>\n<row><cell></cell><cell></cell></row>\n</table>");
	});

	it("inserts a chart skeleton with the type", () => {
		expect(markupEdit("chart", "", "bar")?.insert).toBe(
			"<chart=bar height=8>\n<series=A>1,2,3</series>\n<labels>a,b,c</labels>\n</chart>",
		);
	});

	it("gives a scatter paired samples and no labels, which it would refuse", () => {
		expect(markupEdit("chart", "", "scatter")?.insert).toBe(
			"<chart=scatter height=8>\n<series=A>1:2,2:3,3:5</series>\n</chart>",
		);
	});

	/**
	 * Every type the insert dialog offers, parsed. A skeleton is a promise that what the button wrote
	 * is valid markup, and the four types do not all take the same data.
	 */
	it("leaves every chart skeleton the dialog offers ready to compile", () => {
		for (const type of ["bar", "line", "pie", "scatter"]) {
			const insert = markupEdit("chart", "", type)?.insert ?? "";

			expect(() => parseDocument(insert), `<chart=${type}> skeleton`).not.toThrow();
			expect(parseDocument(insert).nodes).toHaveLength(1);
		}
	});

	it("reports no edit for a chart with no type", () => {
		expect(markupEdit("chart", "")).toBeUndefined();
	});

	it("inserts a gauge and a configured font", () => {
		expect(markupEdit("bar", "", "50")?.insert).toBe("<bar=50>");
		expect(markupEdit("font", "Hi", "mono")?.insert).toBe("<font=mono size=24>Hi</font>");
	});

	it("writes a built-in font without a size, regardless of case", () => {
		expect(markupEdit("font", "Hi", "a")?.insert).toBe("<font=a>Hi</font>");
		expect(markupEdit("font", "Hi", "B")?.insert).toBe("<font=B>Hi</font>");
	});
});
