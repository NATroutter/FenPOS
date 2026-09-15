import { describe, expect, it } from "vitest";
import type { BlockNode } from "@/lib/markup/document";
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

	it("writes attributes into the opening tag", () => {
		expect(markupEdit("size", "BIG", { width: "2", height: "2" })?.insert).toBe("<size width=2 height=2>BIG</size>");
		expect(markupEdit("align", "", { to: "center" })?.insert).toBe("<align to=center></align>");
	});

	it("omits an attribute with an empty value rather than writing a bare key=", () => {
		expect(markupEdit("underline", "x", { weight: "" })?.insert).toBe("<underline>x</underline>");
	});

	it("keeps the selected text when a void tag is pressed, rather than replacing it", () => {
		// The failure this pins is silent data loss: a void tag encloses nothing, so replacing the
		// selection the way a paired tag does would delete what the person had highlighted.
		const edit = markupEdit("hr", "Thank you");

		expect(edit?.insert).toBe("Thank you<hr>");
		expect(edit?.selectionFrom).toBe(edit?.insert.length);
	});

	it("leaves the caret after a void tag inserted at a bare cursor", () => {
		const edit = markupEdit("feed", "", { lines: "3" });

		expect(edit?.insert).toBe("<feed lines=3>");
		expect(edit?.selectionFrom).toBe("<feed lines=3>".length);
	});

	it("reports an unknown tag rather than inventing one", () => {
		expect(markupEdit("blink", "x")).toBeUndefined();
	});

	it("wraps a selection in a box on its own lines", () => {
		expect(markupEdit("box", "Title")).toEqual({ insert: "<box>\nTitle\n</box>", selectionFrom: 6, selectionTo: 11 });
	});

	it("leaves selected lines in a box exactly as they were, since indenting them would print", () => {
		expect(markupEdit("box", "Title\n  - no onion")).toEqual({
			insert: "<box>\nTitle\n  - no onion\n</box>",
			selectionFrom: 6,
			selectionTo: 24,
		});
	});

	it("inserts an indented table skeleton when nothing is selected", () => {
		expect(markupEdit("table", "")).toEqual({
			insert: "<table>\n  <row><cell></cell><cell></cell></row>\n</table>",
			selectionFrom: 21,
			selectionTo: 21,
		});
	});

	it("ignores a selection when inserting a table, since there is nothing in it to carry over", () => {
		expect(markupEdit("table", "some text")?.insert).toBe("<table>\n  <row><cell></cell><cell></cell></row>\n</table>");
	});

	it("inserts an indented chart skeleton with the type", () => {
		expect(markupEdit("chart", "", { type: "bar" })?.insert).toBe(
			"<chart type=bar height=8>\n  <series name=A>1,2,3</series>\n  <labels>a,b,c</labels>\n</chart>",
		);
	});

	it("gives a scatter paired samples and no labels, which it would refuse", () => {
		expect(markupEdit("chart", "", { type: "scatter" })?.insert).toBe(
			"<chart type=scatter height=8>\n  <series name=A>1:2,2:3,3:5</series>\n</chart>",
		);
	});

	/**
	 * Every type the insert dialog offers, parsed. A skeleton is a promise that what the button wrote
	 * is valid markup, and the four types do not all take the same data.
	 */
	it("leaves every chart skeleton the dialog offers ready to compile", () => {
		for (const type of ["bar", "line", "pie", "scatter"]) {
			const insert = markupEdit("chart", "", { type })?.insert ?? "";

			expect(() => parseDocument(insert), `<chart type=${type}> skeleton`).not.toThrow();
			expect(parseDocument(insert).nodes).toHaveLength(1);
		}
	});

	it("reports no edit for a chart with no type", () => {
		expect(markupEdit("chart", "")).toBeUndefined();
		expect(markupEdit("chart", "", { type: "" })).toBeUndefined();
	});

	it("inserts a gauge and a stored font at the default size", () => {
		expect(markupEdit("bar", "", { value: "50" })?.insert).toBe("<bar value=50>");
		expect(markupEdit("text", "Hi", { font: "mono" })?.insert).toBe("<text font=mono size=24>Hi</text>");
	});

	it("writes a built-in font without a size, regardless of case", () => {
		expect(markupEdit("text", "Hi", { font: "a" })?.insert).toBe("<text font=a>Hi</text>");
		expect(markupEdit("text", "Hi", { font: "B" })?.insert).toBe("<text font=B>Hi</text>");
	});

	it("writes a fill character the tokenizer reads back unchanged", () => {
		const written: Record<string, string> = {
			">": '<fill char=">">',
			" ": '<fill char=" ">',
			'"': "<fill char=&quot;>",
			"&": "<fill char=&>",
			"<": "<fill char=<>",
		};

		for (const [character, insert] of Object.entries(written)) {
			expect(markupEdit("fill", "", { char: character })?.insert).toBe(insert);
			expect(parseDocument(insert).nodes[0]).toMatchObject({ kind: "fill", character });
		}
	});

	it("quotes and escapes a text value so it reads back unchanged", () => {
		const name = 'Q1 "best" & <more> &lt;';
		const insert = markupEdit("series", "1,2", { name })?.insert ?? "";

		expect(insert).toBe('<series name="Q1 &quot;best&quot; & <more> &amp;lt;">1,2</series>');
		const chart = parseDocument(`<chart type=bar>\n${insert}\n</chart>`).nodes[0] as BlockNode;
		expect(chart.chart?.series[0].label).toBe(name);
	});
});
