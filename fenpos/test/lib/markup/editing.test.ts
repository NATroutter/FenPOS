import { describe, expect, it } from "vitest";
import type { BlockNode } from "@/lib/markup/document";
import { markupEdit, type SeriesDraft } from "@/lib/markup/editing";
import { parseDocument } from "@/lib/markup/parser";
import { tokenize } from "@/lib/markup/tokenizer";

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
			insert: "<table>\n  <row>\n    <cell></cell>\n    <cell></cell>\n  </row>\n</table>",
			selectionFrom: 26,
			selectionTo: 26,
		});
	});

	it("writes one tag to a line, which is the shape a table has to end up in anyway", () => {
		const insert = markupEdit("table", "")?.insert ?? "";

		expect(insert.split("\n")).toEqual([
			"<table>",
			"  <row>",
			"    <cell></cell>",
			"    <cell></cell>",
			"  </row>",
			"</table>",
		]);
	});

	it("ignores a selection when inserting a table, since there is nothing in it to carry over", () => {
		expect(markupEdit("table", "some text")?.insert).toBe(
			"<table>\n  <row>\n    <cell></cell>\n    <cell></cell>\n  </row>\n</table>",
		);
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

/**
 * What the Insert dialog now hands over: every attribute a tag declares, not just one.
 *
 * The dialog used to carry a single attribute per tag, so a chart could be given its type and
 * nothing else. These pin the shape the opening tag comes out in once several arrive at once.
 */
describe("an opening tag carrying several attributes", () => {
	it("writes every one of them", () => {
		const edit = markupEdit("chart", "", { type: "bar", width: "80", height: "6", legend: "on" });

		expect(edit?.insert.startsWith("<chart type=bar width=80 height=6 legend=on>")).toBe(true);
	});

	it("quotes a value that holds a space, which a title routinely does", () => {
		const edit = markupEdit("chart", "", { type: "bar", title: "Cups by hour" });

		expect(edit?.insert.startsWith('<chart type=bar title="Cups by hour" height=8>')).toBe(true);
	});

	it("leaves an attribute nobody filled in out of the tag", () => {
		const edit = markupEdit("qr", "", { size: "" });

		expect(edit?.insert.startsWith("<qr>")).toBe(true);
	});
});

/**
 * The structures a dialog fills in, rather than the skeletons it used to leave behind.
 *
 * A skeleton is a guess at what somebody wanted — one series called A holding 1,2,3 — and every one
 * of them was going to be selected and retyped. These cases are about what comes out once the data
 * arrives with the tag, and about the caret, which belongs past a table that is already filled in
 * rather than inside its first cell.
 */
describe("a tag whose structure was collected", () => {
	const series = (values: string, attributes: Record<string, string> = {}): SeriesDraft => ({ values, attributes });

	it("writes a chart's series and labels, one tag to a line", () => {
		const edit = markupEdit(
			"chart",
			"",
			{ type: "line", height: "10" },
			{
				kind: "chart",
				series: [series("62,64,68", { name: "Temp", marker: "circle" }), series("50,51,53", { name: "Dew" })],
				labels: "08,09,10",
			},
		);

		expect(edit?.insert.split("\n")).toEqual([
			"<chart type=line height=10>",
			"  <series name=Temp marker=circle>62,64,68</series>",
			"  <series name=Dew>50,51,53</series>",
			"  <labels>08,09,10</labels>",
			"</chart>",
		]);
	});

	it("leaves the caret past a chart it filled in, since nothing in it wants replacing", () => {
		const edit = markupEdit("chart", "", { type: "bar" }, { kind: "chart", series: [series("1,2")], labels: "" });

		expect(edit?.selectionFrom).toBe(edit?.insert.length);
		expect(edit?.selectionTo).toBe(edit?.insert.length);
	});

	it("drops a series nobody gave values to, and writes no empty labels", () => {
		const edit = markupEdit(
			"chart",
			"",
			{ type: "bar" },
			{ kind: "chart", series: [series("1,2,3"), series("  "), series("")], labels: "   " },
		);

		expect(edit?.insert).toBe("<chart type=bar height=8>\n  <series>1,2,3</series>\n</chart>");
	});

	it("writes a table's grid, a cell to a line", () => {
		const edit = markupEdit(
			"table",
			"",
			{ width: "80", border: "single" },
			{
				kind: "table",
				rows: [
					["Item", "Price"],
					["Coffee", "2.50"],
				],
			},
		);

		expect(edit?.insert.split("\n")).toEqual([
			"<table width=80 border=single>",
			"  <row>",
			"    <cell>Item</cell>",
			"    <cell>Price</cell>",
			"  </row>",
			"  <row>",
			"    <cell>Coffee</cell>",
			"    <cell>2.50</cell>",
			"  </row>",
			"</table>",
		]);
		expect(edit?.selectionFrom).toBe(edit?.insert.length);
	});

	it("writes an empty cell as an empty cell, since the column was asked for", () => {
		const edit = markupEdit("table", "", undefined, { kind: "table", rows: [["", "Price"]] });

		expect(edit?.insert).toBe("<table>\n  <row>\n    <cell></cell>\n    <cell>Price</cell>\n  </row>\n</table>");
	});

	/** Content, not an attribute value: the three characters that mean something where they stand. */
	it("escapes content the tokenizer would otherwise read as markup", () => {
		const edit = markupEdit("table", "", undefined, { kind: "table", rows: [["<b & {name} &lt;"]] });

		expect(edit?.insert).toContain("<cell>&lt;b & &lbrace;name} &amp;lt;</cell>");
		expect(() => parseDocument(edit?.insert ?? "")).not.toThrow();

		// What the tokenizer reads back out of the escaped cell is what was typed into it.
		const read = tokenize("&lt;b & &lbrace;name} &amp;lt;", null)
			.tokens.filter((token) => token.kind === "text")
			.map((token) => token.text)
			.join("");
		expect(read).toBe("<b & {name} &lt;");
	});

	it("frames a selection in a box that carries its attributes", () => {
		const edit = markupEdit("box", "Title", { width: "60", border: "double", pad: "1" });

		expect(edit?.insert).toBe("<box width=60 border=double pad=1>\nTitle\n</box>");
		expect(edit?.insert.slice(edit.selectionFrom, edit.selectionTo)).toBe("Title");
	});

	it("carries a table's attributes into the skeleton written without data", () => {
		expect(markupEdit("table", "", { border: "thick" })?.insert.startsWith("<table border=thick>\n")).toBe(true);
	});

	/**
	 * Every type, filled in the way its dialog fills it. What a button writes has to compile, and the
	 * four types disagree about labels, about pairs, and about how many series they draw.
	 */
	it("leaves every chart the dialog collects ready to compile", () => {
		const collected: Record<string, { series: SeriesDraft[]; labels: string }> = {
			bar: { series: [series("1,2,3", { name: "A" }), series("2,3,4", { name: "B" })], labels: "a,b,c" },
			line: { series: [series("1,2,3", { marker: "circle" })], labels: "a,b,c" },
			pie: { series: [series("1,2,3")], labels: "a,b,c" },
			scatter: { series: [series("1:2, 2:3", { marker: "cross" })], labels: "" },
		};

		for (const [type, data] of Object.entries(collected)) {
			const insert = markupEdit("chart", "", { type }, { kind: "chart", ...data })?.insert ?? "";

			expect(() => parseDocument(insert), `<chart type=${type}>`).not.toThrow();
			expect(parseDocument(insert).nodes, `<chart type=${type}>`).toHaveLength(1);
		}
	});
});
