import { describe, expect, it } from "vitest";
import { flattenLine, needsRaster, splitLines } from "@/lib/markup/flatten";
import { parseDocument } from "@/lib/markup/parser";

describe("splitLines", () => {
	it("gives one entry per line and carries a spanning scope into each", () => {
		const lines = splitLines(parseDocument("<bold>a\nb</bold>\nc").nodes);

		expect(lines.map((line) => line.number)).toEqual([1, 2, 3]);
		expect(lines[0].nodes).toEqual([
			{
				kind: "scope",
				tag: "bold",
				patch: { bold: true },
				line: 1,
				column: 1,
				children: [{ kind: "text", text: "a", line: 1, column: 7 }],
			},
		]);
		expect(lines[1].nodes[0]).toMatchObject({
			kind: "scope",
			tag: "bold",
			children: [{ kind: "text", text: "b", line: 2, column: 1 }],
		});
		expect(lines[2].nodes).toEqual([{ kind: "text", text: "c", line: 3, column: 1 }]);
	});

	it("keeps an empty line as an empty entry", () => {
		expect(splitLines(parseDocument("a\n\nb").nodes).map((line) => line.nodes.length)).toEqual([1, 0, 1]);
	});

	it("carries align across the lines it spans", () => {
		const lines = splitLines(parseDocument("<align to=center>a\nb</align>").nodes);

		expect(lines[0].nodes[0]).toMatchObject({ kind: "align", align: "CENTER" });
		expect(lines[1].nodes[0]).toMatchObject({ kind: "align", align: "CENTER" });
	});

	/**
	 * A tag enclosing data prints nothing for the lines it swallows, so it leaves no break behind
	 * for them. The number of what follows therefore has to come from the break that ends its
	 * closing line rather than from counting the entries produced so far.
	 */
	it("takes the next line's number from the break, not from the entries counted", () => {
		const lines = splitLines(parseDocument("<image>\nlogo\n</image>\nafter").nodes);

		expect(lines.map((line) => line.number)).toEqual([1, 4]);
		expect(lines[0].nodes[0]).toMatchObject({ kind: "image", ref: "logo" });
		expect(lines[1].nodes[0]).toMatchObject({ kind: "text", text: "after" });
	});
});

describe("flattenLine", () => {
	it("produces the same Line the old parser did", () => {
		const line = flattenLine(
			splitLines(parseDocument("<align to=right><bold>Total</bold><fill>5.50</align>").nodes)[0].nodes,
		);

		expect(line.align).toBe("RIGHT");
		expect(line.wrap).toBeNull();
		expect(line.spans.map((span) => [span.text, span.style.bold, span.sourceColumn])).toEqual([
			["Total", true, 23],
			["5.50", false, 41],
		]);
		expect(line.fills).toEqual([{ afterSpans: 1, character: " ", style: line.spans[1].style, sourceColumn: 35 }]);
	});

	it("keeps a spanning scope's style on the second line", () => {
		const second = flattenLine(splitLines(parseDocument("<bold>a\nb</bold>").nodes)[1].nodes);

		expect(second.spans[0]).toMatchObject({ text: "b", style: { bold: true }, sourceColumn: 1 });
	});

	it("measures a symbol into its directive", () => {
		const line = flattenLine(splitLines(parseDocument("<qr size=4>https://x</qr>").nodes)[0].nodes);

		expect(line.directives[0]).toMatchObject({ kind: "QR", content: "https://x", size: 4, sourceColumn: 1 });
		expect((line.directives[0] as { heightLines: number }).heightLines).toBeGreaterThan(0);
	});

	it("defaults a top-level image to the full width", () => {
		expect(flattenLine(parseDocument("<image>logo</image>").nodes).directives[0]).toEqual({
			kind: "IMAGE",
			ref: "logo",
			widthPercent: 100,
		});
	});
});

describe("needsRaster", () => {
	it("is false for native text, symbols and a lone image", () => {
		expect(needsRaster(parseDocument("<bold>a</bold>").nodes)).toBe(false);
		expect(needsRaster(parseDocument("<align to=center><image>logo</image></align>").nodes)).toBe(false);
		expect(needsRaster(parseDocument("<qr>x</qr>").nodes)).toBe(false);
	});

	it("is true for a configured font and false for a built-in one", () => {
		expect(needsRaster(parseDocument("<text font=roboto>a</text>").nodes)).toBe(true);
		expect(needsRaster(parseDocument("<text font=b>a</text>").nodes)).toBe(false);
	});
});
