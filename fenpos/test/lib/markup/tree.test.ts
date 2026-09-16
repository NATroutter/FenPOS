import { describe, expect, it } from "vitest";
import { type BlockNode, DEFAULT_PARSE_OPTIONS, type Document, type Node } from "@/lib/markup/document";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import { needsRaster } from "@/lib/markup/flatten";
import { tokenize } from "@/lib/markup/tokenizer";
import { buildDocument } from "@/lib/markup/tree";

const build = (source: string): Document => buildDocument(tokenize(source, null), DEFAULT_PARSE_OPTIONS);

const refusal = (source: string): MarkupError => {
	try {
		build(source);
	} catch (thrown) {
		if (thrown instanceof MarkupError) {
			return thrown;
		}
		throw thrown;
	}
	throw new Error(`expected '${source}' to be refused`);
};

const kinds = (nodes: Node[]): string[] => nodes.map((node) => node.kind);

describe("buildDocument", () => {
	it("keeps text and breaks at the top level", () => {
		const document = build("a\nb");

		expect(kinds(document.nodes)).toEqual(["text", "break", "text"]);
		expect(document.lines).toEqual([
			{ number: 1, chars: 1, interior: false },
			{ number: 2, chars: 1, interior: false },
		]);
	});

	it("nests a styling scope with its resolved patch", () => {
		const document = build("<bold>a</bold>");

		expect(document.nodes[0]).toMatchObject({ kind: "scope", tag: "bold", patch: { bold: true }, line: 1, column: 1 });
		expect(kinds((document.nodes[0] as { children: Node[] }).children)).toEqual(["text"]);
	});

	it("lets a scope span lines, keeping the break inside it", () => {
		const document = build("<bold>a\nb</bold>");

		expect(kinds((document.nodes[0] as { children: Node[] }).children)).toEqual(["text", "break", "text"]);
	});

	it("reports an unclosed tag at the line and column it opened", () => {
		const thrown = refusal("x\n  <bold>y\nz");

		expect(thrown.code).toBe(MARKUP_ERRORS.unclosedTag);
		expect(thrown.line).toBe(2);
		expect(thrown.column).toBe(3);
		expect(thrown.detail).toBe("bold");
	});

	it("reports a mismatched close on its own line", () => {
		const thrown = refusal("<bold>a\n</size>");

		expect(thrown.code).toBe(MARKUP_ERRORS.unexpectedCloseTag);
		expect(thrown.line).toBe(2);
		expect(thrown.column).toBe(1);
	});

	it("resolves size into width and height multipliers", () => {
		expect(build("<size width=2 height=3>a</size>").nodes[0]).toMatchObject({ patch: { widthMult: 2, heightMult: 3 } });
		expect(build("<size width=2 height=2>a</size>").nodes[0]).toMatchObject({ patch: { widthMult: 2, heightMult: 2 } });
		expect(refusal("<size width=9 height=9>a</size>").code).toBe(MARKUP_ERRORS.invalidAttribute);
	});

	it("bounds underline's weight to the printer's two heavier styles", () => {
		expect(build("<underline weight=2>a</underline>").nodes[0]).toMatchObject({ patch: { underline: 2 } });
		expect(refusal("<underline weight=3>a</underline>")).toMatchObject({
			code: MARKUP_ERRORS.invalidAttribute,
			column: 12,
		});
	});

	it("lets align span several lines when it owns each of them", () => {
		const document = build("<align to=center>a\nb</align>");

		expect(document.nodes[0]).toMatchObject({ kind: "align", align: "CENTER" });
		expect(kinds((document.nodes[0] as { children: Node[] }).children)).toEqual(["text", "break", "text"]);
	});

	it("refuses align opened after text on the same line", () => {
		const thrown = refusal("x <align to=center>a</align>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAlignScope);
		expect(thrown.column).toBe(3);
	});

	it("refuses align opened after text on an earlier line inside a scope", () => {
		expect(refusal("<bold>x\n<align to=center>a</align></bold>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("refuses text after align closes on the same line", () => {
		// The space is the first thing that follows the close, so it is what is pointed at.
		const thrown = refusal("<align to=center>a</align> b");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAlignScope);
		expect(thrown.column).toBe(27);
	});

	it("allows the next line to start fresh after align closes", () => {
		expect(kinds(build("<align to=center>a</align>\nb").nodes)).toEqual(["align", "break", "text"]);
	});

	it("refuses a second align while one is open", () => {
		expect(refusal("<align to=center>a\n<align to=left>b</align></align>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("names the tag being opened when a second align follows the first on one line", () => {
		const thrown = refusal("<align to=center>a</align><align to=left>b</align>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAlignScope);
		expect(thrown.detail).toBe("align");
		expect(thrown.column).toBe(27);
	});

	it("names the tag being opened when nowrap follows a closed wrap on one line", () => {
		const thrown = refusal("<wrap>a</wrap><nowrap>b</nowrap>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidWrapScope);
		expect(thrown.detail).toBe("nowrap");
		expect(thrown.column).toBe(15);
	});

	it("refuses wrap inside a styling scope", () => {
		expect(refusal("<bold><nowrap>x</nowrap></bold>").code).toBe(MARKUP_ERRORS.invalidWrapScope);
	});

	it("requires hr to be alone on its line", () => {
		expect(kinds(build("a\n<hr>\nb").nodes)).toEqual(["text", "break", "rule", "break", "text"]);
		expect(refusal("a<hr>").code).toBe(MARKUP_ERRORS.invalidRuleScope);
		expect(refusal("<hr>b").code).toBe(MARKUP_ERRORS.invalidRuleScope);
	});

	it("lets a symbol sit inside align and nothing else", () => {
		const document = build("<align to=center><qr>https://x</qr></align>");

		expect(document.nodes[0]).toMatchObject({ kind: "align" });
		expect((document.nodes[0] as { children: Node[] }).children[0]).toMatchObject({
			kind: "symbol",
			spec: { kind: "QR", content: "https://x", size: 6 },
		});
		expect(refusal("Scan: <qr>x</qr>").code).toBe(MARKUP_ERRORS.invalidBlockScope);
	});

	it("trims line breaks inside a content tag and marks the interior lines", () => {
		const document = build("<image>\nlogo\n</image>");

		expect(document.nodes[0]).toMatchObject({ kind: "image", ref: "logo", widthPercent: null });
		expect(document.lines.map((line) => line.interior)).toEqual([false, true, false]);
	});

	it("refuses markup inside a content tag", () => {
		const thrown = refusal("<qr><bold>x</bold></qr>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidBlockScope);
		expect(thrown.column).toBe(5);
	});

	it("keeps the image width when given", () => {
		expect(build("<image width=50>logo</image>").nodes[0]).toMatchObject({ kind: "image", widthPercent: 50 });
	});

	it("refuses a control character in a symbol's content through the tokenizer", () => {
		expect(refusal("<qr>a</qr>").code).toBe(MARKUP_ERRORS.controlCharacter);
	});

	it("resolves void tags into directives", () => {
		const document = build("<cut mode=partial><feed lines=3><drawer pin=5>");

		expect(document.nodes).toEqual([
			{ kind: "void", directive: { kind: "CUT", mode: "PARTIAL" }, line: 1, column: 1 },
			{ kind: "void", directive: { kind: "FEED", lines: 3 }, line: 1, column: 19 },
			{ kind: "void", directive: { kind: "DRAWER", pin: 5 }, line: 1, column: 33 },
		]);
	});

	it("keeps a fill with its character", () => {
		expect(build("a<fill char=.>b").nodes[1]).toEqual({ kind: "fill", character: ".", line: 1, column: 2 });
	});

	/** A fill places something on the line, so the line is no longer a fresh one an align could own. */
	it("refuses align opened after a fill on the same line", () => {
		expect(refusal("<fill><align to=center>x</align>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("refuses a close tag for a tag that stands alone", () => {
		const thrown = refusal("</hr>");

		expect(thrown.code).toBe(MARKUP_ERRORS.unexpectedCloseTag);
		expect(thrown.detail).toBe("hr");
	});

	it("names an unknown tag and the column it was written at", () => {
		const thrown = refusal("ab <blink>x</blink>");

		expect(thrown.code).toBe(MARKUP_ERRORS.unknownTag);
		expect(thrown.detail).toBe("blink");
		expect(thrown.column).toBe(4);
	});

	it("refuses an attribute on a tag that takes none", () => {
		const thrown = refusal("<bold weight=2>x</bold>");

		expect(thrown.code).toBe(MARKUP_ERRORS.unknownAttribute);
		expect(thrown.column).toBe(7);
	});

	it("resolves a built-in font and refuses size on it", () => {
		expect(build("<text font=b>x</text>").nodes[0]).toMatchObject({ patch: { font: "B", face: null } });
		const thrown = refusal("<text font=a size=30>x</text>");
		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(14);
	});

	it("resolves a configured font with a size", () => {
		expect(build("<text font=roboto size=36>x</text>").nodes[0]).toMatchObject({
			patch: { face: "roboto", faceDots: 36 },
		});
		expect(build("<text font=roboto>x</text>").nodes[0]).toMatchObject({ patch: { face: "roboto", faceDots: 24 } });
	});

	it("bounds the font size by the parse options", () => {
		const generous = buildDocument(tokenize("<text font=roboto size=600>x</text>", null), {
			...DEFAULT_PARSE_OPTIONS,
			maxFontHeight: 1024,
		});
		expect(generous.nodes[0]).toMatchObject({ patch: { faceDots: 600 } });
		expect(refusal("<text font=roboto size=600>x</text>").code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(refusal("<text font=roboto size=7>x</text>").code).toBe(MARKUP_ERRORS.invalidAttribute);
	});

	it("refuses a font name that is not a name", () => {
		expect(refusal("<text font=Roboto>x</text>").code).toBe(MARKUP_ERRORS.invalidAttribute);
	});

	it("decodes a data URI image, wrapped over lines", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
		const node = build(`<image>data:image/png;base64,${png.slice(0, 3)}\n${png.slice(3)}</image>`).nodes[0];

		expect(node).toMatchObject({ kind: "image", source: { kind: "data", mimeType: "image/png" } });
		expect((node as { source: { bytes: Buffer } }).source.bytes).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	});

	it("refuses a data URI that is not a PNG or JPEG, or not base64", () => {
		expect(refusal("<image>data:image/gif;base64,R0lG</image>").code).toBe(MARKUP_ERRORS.invalidImageData);
		expect(refusal("<image>data:image/png;base64,***</image>").code).toBe(MARKUP_ERRORS.invalidImageData);
	});

	it("reads size from width and height, either alone leaving the other at 1", () => {
		expect(build("<size width=2 height=3>a</size>").nodes[0]).toMatchObject({ patch: { widthMult: 2, heightMult: 3 } });
		expect(build("<size width=2>a</size>").nodes[0]).toMatchObject({ patch: { widthMult: 2, heightMult: 1 } });
		expect(build("<size height=3>a</size>").nodes[0]).toMatchObject({ patch: { widthMult: 1, heightMult: 3 } });
	});

	it("refuses a size with neither width nor height, at the tag", () => {
		const thrown = refusal("<size>a</size>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(1);
		expect(thrown.detail).toBe("width");
		expect(thrown.message).toBe("<size> needs width or height, or both");
	});

	it("refuses a multiplier out of range at the attribute's column", () => {
		const thrown = refusal("<size width=9>a</size>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(7);
	});

	it("selects a built-in font by letter, ignoring case", () => {
		expect(build("<text font=B>a</text>").nodes[0]).toMatchObject({
			kind: "scope",
			tag: "text",
			patch: { font: "B", face: null, faceDots: 24 },
		});
	});

	it("selects a stored font by name at a size", () => {
		expect(build("<text font=mono size=32>a</text>").nodes[0]).toMatchObject({ patch: { face: "mono", faceDots: 32 } });
		expect(build("<text font=mono>a</text>").nodes[0]).toMatchObject({ patch: { face: "mono", faceDots: 24 } });
	});

	it("refuses a size on a built-in font, at the size", () => {
		const thrown = refusal("<text font=a size=32>a</text>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(14);
		expect(thrown.detail).toBe("size");
	});

	it("refuses a font that is neither a letter nor a name, at the font", () => {
		const thrown = refusal("<text font=no/pe>a</text>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(7);
		expect(thrown.detail).toBe("font");
	});

	it("requires a font on text", () => {
		expect(refusal("<text>a</text>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, detail: "font" });
	});

	it("reads align from to, ignoring case", () => {
		expect(build("<align to=Center>a</align>").nodes[0]).toMatchObject({ kind: "align", align: "CENTER" });
		expect(refusal("<align to=middle>a</align>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, column: 8 });
		expect(refusal("<align>a</align>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, detail: "to" });
	});

	it("reads a fill's character from char, a space when it is left off", () => {
		expect(build("<fill char=.>").nodes[0]).toMatchObject({ kind: "fill", character: "." });
		expect(build("<fill>").nodes[0]).toMatchObject({ kind: "fill", character: " " });
		expect(refusal("<fill char=ab>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, column: 7 });
	});

	it("reads the void directives from their attributes", () => {
		expect(build("<cut mode=partial>").nodes[0]).toMatchObject({ directive: { kind: "CUT", mode: "PARTIAL" } });
		expect(build("<cut>").nodes[0]).toMatchObject({ directive: { kind: "CUT", mode: "FULL" } });
		expect(build("<feed lines=3>").nodes[0]).toMatchObject({ directive: { kind: "FEED", lines: 3 } });
		expect(refusal("<feed>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, detail: "lines" });
		expect(refusal("<feed lines=0>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, column: 7 });
		expect(build("<drawer pin=5>").nodes[0]).toMatchObject({ directive: { kind: "DRAWER", pin: 5 } });
		expect(build("<drawer>").nodes[0]).toMatchObject({ directive: { kind: "DRAWER", pin: 2 } });
		expect(refusal("<drawer pin=3>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, column: 9 });
	});

	it("reads the content tags' shapes from their attributes", () => {
		expect(build("<qr size=8>x</qr>").nodes[0]).toMatchObject({ spec: { kind: "QR", size: 8 } });
		expect(build("<qr>x</qr>").nodes[0]).toMatchObject({ spec: { kind: "QR", size: 6 } });
		expect(build("<pdf417 level=4>x</pdf417>").nodes[0]).toMatchObject({ spec: { kind: "PDF417", errorLevel: 4 } });
		expect(build("<pdf417>x</pdf417>").nodes[0]).toMatchObject({ spec: { kind: "PDF417", errorLevel: 1 } });
		expect(build("<barcode type=ean13>5901234123457</barcode>").nodes[0]).toMatchObject({
			spec: { kind: "BARCODE", system: "EAN13" },
		});
		expect(refusal("<barcode>1</barcode>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, detail: "type" });
		expect(build("<image width=50>logo</image>").nodes[0]).toMatchObject({ kind: "image", widthPercent: 50 });
		expect(build("<image>logo</image>").nodes[0]).toMatchObject({ kind: "image", widthPercent: null });
	});

	it("bounds each content tag's size attribute to what the printer accepts", () => {
		expect(build("<qr size=16>x</qr>").nodes[0]).toMatchObject({ spec: { kind: "QR", size: 16 } });
		expect(refusal("<qr size=17>x</qr>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, column: 5 });
		expect(build("<pdf417 level=0>x</pdf417>").nodes[0]).toMatchObject({ spec: { kind: "PDF417", errorLevel: 0 } });
		expect(build("<pdf417 level=8>x</pdf417>").nodes[0]).toMatchObject({ spec: { kind: "PDF417", errorLevel: 8 } });
		expect(refusal("<pdf417 level=9>x</pdf417>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, column: 9 });
		expect(build("<image width=1>logo</image>").nodes[0]).toMatchObject({ kind: "image", widthPercent: 1 });
		expect(build("<image width=100>logo</image>").nodes[0]).toMatchObject({ kind: "image", widthPercent: 100 });
		expect(refusal("<image width=0>logo</image>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, column: 8 });
		expect(refusal("<image width=101>logo</image>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, column: 8 });
	});

	it("reads a chart's type, a series' name and a gauge's value from their attributes", () => {
		const chart = build('<chart type=BAR><series name="Q1 sales">1</series></chart>').nodes[0] as BlockNode;

		expect(chart.attributes.type).toBe("bar");
		expect(chart.chart?.type).toBe("bar");
		expect(chart.chart?.series[0].label).toBe("Q1 sales");
		expect(refusal("<chart><series>1</series></chart>")).toMatchObject({
			code: MARKUP_ERRORS.invalidAttribute,
			detail: "type",
		});
		expect((build("<bar value=38>").nodes[0] as BlockNode).attributes.value).toBe(38);
		expect(refusal("<bar>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, detail: "value" });
	});

	it("bounds the gauge's value to a whole percentage", () => {
		expect((build("<bar value=0>").nodes[0] as BlockNode).attributes.value).toBe(0);
		expect((build("<bar value=100>").nodes[0] as BlockNode).attributes.value).toBe(100);
	});

	it("refuses a value written against a tag that takes none as a malformed attribute", () => {
		expect(refusal("<bold=1>x</bold>")).toMatchObject({ code: MARKUP_ERRORS.unknownAttribute, column: 6, detail: "=" });
	});

	it("lets an indented tag own its line", () => {
		expect(build("  <align to=center>a</align>").nodes[0]).toMatchObject({ kind: "align", column: 3 });
		expect(build("  - no onion").nodes[0]).toMatchObject({ kind: "text", text: "  - no onion" });
	});

	it("builds an indented block the same as a flat one", () => {
		const indented = build("<box>\n  <align to=center>a</align>\n</box>").nodes[0] as BlockNode;
		const flat = build("<box>\n<align to=center>a</align>\n</box>").nodes[0] as BlockNode;

		expect(kinds(indented.children)).toEqual(["break", "align", "break"]);
		expect(kinds(indented.children)).toEqual(kinds(flat.children));
	});

	it("builds a scope opened and closed on its own line the same as one written on a line", () => {
		const split = build("<box>\n  <align to=center>\n    <bold>a</bold>\n  </align>\n</box>").nodes[0] as BlockNode;
		const flat = build("<box>\n  <align to=center><bold>a</bold></align>\n</box>").nodes[0] as BlockNode;

		expect(kinds(split.children)).toEqual(kinds(flat.children));
		expect(kinds((split.children[1] as { children: Node[] }).children)).toEqual(["scope"]);
		expect(kinds((flat.children[1] as { children: Node[] }).children)).toEqual(["scope"]);
	});

	it("keeps a blank line the author wrote inside a scope", () => {
		const node = build("<align to=center>\na\n\nb\n</align>").nodes[0];

		expect(kinds((node as { children: Node[] }).children)).toEqual(["text", "break", "break", "text"]);
	});

	it("drops the newline before a closing tag written on a later line", () => {
		const document = build("<bold>a\n  </bold>");

		expect(kinds(document.nodes)).toEqual(["scope"]);
		expect(kinds((document.nodes[0] as { children: Node[] }).children)).toEqual(["text"]);
	});
});

describe("block tags", () => {
	const block = (source: string): Node => build(source).nodes[0];

	it("builds a box with its attributes and children", () => {
		expect(block("<box width=60 border=double pad=0>\nhi\n</box>")).toMatchObject({
			kind: "block",
			tag: "box",
			attributes: { width: 60, border: "double", pad: 0 },
			children: [{ kind: "break" }, { kind: "text", text: "hi" }, { kind: "break" }],
		});
	});

	it("keeps a row of cells on one line without stray text", () => {
		const table = block("<table>\n<row><cell>a</cell> <cell align=center>b</cell></row>\n</table>") as BlockNode;
		const row = table.children.find((node) => node.kind === "block") as BlockNode;

		expect(row.children.map((node) => node.kind)).toEqual(["block", "block"]);
	});

	it("drops the whitespace around a row written on its own line", () => {
		const table = block("<table>\n  <row><cell>a</cell></row>  \n</table>") as BlockNode;

		expect(table.children.map((node) => node.kind)).toEqual(["break", "block", "break"]);
	});

	it("refuses a box opened after text", () => {
		const thrown = refusal("x <box>\n</box>");
		expect(thrown.code).toBe(MARKUP_ERRORS.invalidBlockScope);
		expect(thrown.column).toBe(3);
	});

	it("refuses text after a box closes on its line", () => {
		expect(refusal("<box>\na\n</box> b").code).toBe(MARKUP_ERRORS.invalidBlockScope);
	});

	it("drops trailing whitespace after a box closes on its line", () => {
		expect(() => build("<box>\nA\n</box>  ")).not.toThrow();
	});

	/**
	 * The trailing-whitespace pass belongs to a whole-line block closing, not to a line-sharing one
	 * like `<bar>` merely having appeared on the line. An align or a wrap still owns the line's
	 * justification whatever shares it, so nothing may follow their closer either — blank or not.
	 */
	it("still refuses trailing whitespace after an align closes, even when a gauge shared its line", () => {
		expect(refusal("<align to=center><bar value=50></align>  ").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("still refuses trailing whitespace after a wrap closes, even when a gauge shared its line", () => {
		expect(refusal("<nowrap><bar value=50></nowrap>  ").code).toBe(MARKUP_ERRORS.invalidWrapScope);
	});

	it("refuses a row outside a table and a cell outside a row", () => {
		expect(refusal("<row></row>").code).toBe(MARKUP_ERRORS.misplacedBlock);
		expect(refusal("<table>\n<cell>a</cell>\n</table>").code).toBe(MARKUP_ERRORS.misplacedBlock);
		expect(refusal("<box>\n<row></row>\n</box>").code).toBe(MARKUP_ERRORS.misplacedBlock);
	});

	it("refuses text directly inside a table or a row", () => {
		expect(refusal("<table>\nloose\n</table>").code).toBe(MARKUP_ERRORS.misplacedBlock);
		expect(refusal("<table>\n<row>loose<cell>a</cell></row>\n</table>").code).toBe(MARKUP_ERRORS.misplacedBlock);
	});

	it("refuses a symbol or a printer command inside a block", () => {
		expect(refusal("<box>\n<qr>x</qr>\n</box>").code).toBe(MARKUP_ERRORS.misplacedBlock);
		expect(refusal("<box>\n<cut>\n</box>").code).toBe(MARKUP_ERRORS.misplacedBlock);
	});

	it("lets a chart hold series and labels only", () => {
		const chart = block(
			"<chart type=bar height=8>\n<series name=Sales pattern=hatch>1,2,3</series>\n<labels>a,b,c</labels>\n</chart>",
		) as BlockNode;

		expect(chart.attributes.type).toBe("bar");
		expect(chart.children.filter((node) => node.kind === "block").map((node) => (node as BlockNode).content)).toEqual([
			"1,2,3",
			"a,b,c",
		]);
		expect(refusal("<chart type=bar>\ntext\n</chart>").code).toBe(MARKUP_ERRORS.misplacedBlock);
		expect(refusal("<chart type=bar>\n<bar value=10>\n</chart>").code).toBe(MARKUP_ERRORS.misplacedBlock);
		expect(refusal("<chart type=donut>\n</chart>").code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(refusal("<chart type=bar area=on>\n</chart>").code).toBe(MARKUP_ERRORS.invalidAttribute);
	});

	it("parses series values, scatter pairs and labels", () => {
		const scatter = block("<chart type=scatter>\n<series name=A>1:2, 3:4\n5:6</series>\n</chart>") as BlockNode;

		expect(scatter.chart?.series[0].points).toEqual([
			[1, 2],
			[3, 4],
			[5, 6],
		]);
		expect(scatter.chart?.series[0].marker).toBe("circle");

		const line = block("<chart type=line>\n<series name=A>1,2</series>\n<labels>x,y</labels>\n</chart>") as BlockNode;

		expect(line.chart?.labels).toEqual(["x", "y"]);
	});

	it("refuses labels on a scatter, whose axes carry numbers of their own", () => {
		const thrown = refusal("<chart type=scatter>\n<series name=A>1:2</series>\n<labels>x</labels>\n</chart>");

		expect(thrown.code).toBe(MARKUP_ERRORS.misplacedBlock);
		expect(thrown.line).toBe(3);
		expect(thrown.column).toBe(1);
	});

	it("refuses a value that is not a number, too many points and too many labels", () => {
		expect(refusal("<chart type=bar>\n<series>1,two</series>\n</chart>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
		expect(refusal("<chart type=bar>\n<series>1,2</series>\n<labels>a,b,c</labels>\n</chart>").code).toBe(
			MARKUP_ERRORS.tooManyLabels,
		);
		const many = Array.from({ length: 2001 }, (_, index) => index).join(",");
		expect(refusal(`<chart type=line>\n<series>${many}</series>\n</chart>`).code).toBe(MARKUP_ERRORS.tooManyPoints);
	});

	it("requires one series for a pie and at least one series for any chart", () => {
		expect(refusal("<chart type=pie>\n<series>1</series>\n<series>2</series>\n</chart>").code).toBe(
			MARKUP_ERRORS.invalidTagArgument,
		);
		expect(refusal("<chart type=bar>\n</chart>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("refuses a pie slice that is not worth a share", () => {
		const thrown = refusal("<chart type=pie>\n<series>3,0,1</series>\n</chart>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidTagArgument);
		expect(thrown.line).toBe(2);
		expect(refusal("<chart type=pie>\n<series>3,-1</series>\n</chart>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
		expect(() => build("<chart type=bar>\n<series>3,0,-1</series>\n</chart>")).not.toThrow();
	});

	it("assigns patterns and markers by order", () => {
		const chart = block(
			"<chart type=bar>\n<series>1</series>\n<series>2</series>\n<series>3</series>\n<series>4</series>\n<series>5</series>\n</chart>",
		) as BlockNode;

		expect(chart.chart?.series.map((series) => series.pattern)).toEqual(["solid", "hatch", "dot", "hollow", "solid"]);
	});

	it("allows a marker only on a chart that plots points", () => {
		expect(() => build("<chart type=scatter>\n<series marker=cross>1:2,3:4</series>\n</chart>")).not.toThrow();

		const thrown = refusal("<chart type=pie>\n<series marker=cross>1,2</series>\n</chart>");
		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.line).toBe(2);
	});

	it("reads the gauge", () => {
		expect(block("<bar value=38 width=80>")).toMatchObject({
			kind: "block",
			tag: "bar",
			attributes: { value: 38, width: 80 },
		});
		expect(refusal("<bar value=101>")).toMatchObject({ code: MARKUP_ERRORS.invalidAttribute, column: 6 });
	});

	it("bounds nesting depth", () => {
		const deep = `${"<box>\n".repeat(17)}x\n${"</box>\n".repeat(17)}`;
		const thrown = refusal(deep);

		expect(thrown.code).toBe(MARKUP_ERRORS.nestingTooDeep);
		expect(thrown.line).toBe(17);
		expect(() => buildDocument(tokenize(deep, null), { ...DEFAULT_PARSE_OPTIONS, maxBlockDepth: 17 })).not.toThrow();
	});

	it("bounds cells per table", () => {
		const cells = "<cell>a</cell>".repeat(5);
		const thrown = (() => {
			try {
				buildDocument(tokenize(`<table>\n<row>${cells}</row>\n</table>`, null), {
					...DEFAULT_PARSE_OPTIONS,
					maxTableCells: 4,
				});
			} catch (error) {
				return error as MarkupError;
			}
			throw new Error("expected a refusal");
		})();

		expect(thrown.code).toBe(MARKUP_ERRORS.tooManyCells);
	});

	it("lets an image sit inline inside a cell with no width", () => {
		const cell = build("<table>\n<row><cell>08 <image>cloud</image></cell></row>\n</table>");
		const found = JSON.stringify(cell.nodes);

		expect(found).toContain('"kind":"image"');
		expect(found).toContain('"widthPercent":null');
	});

	/** The block's last line is verified when it closes, which is the only time anything ends it. */
	it("keeps the sole rule for a rule inside a box, to the block's last line", () => {
		expect(() => build("<box>\n<hr>\n</box>")).not.toThrow();
		expect(refusal("<box>\n<hr> x</box>").code).toBe(MARKUP_ERRORS.invalidRuleScope);
	});

	it("lets align own a line inside a box", () => {
		expect(() => build("<box>\n<align to=center>hi</align>\n</box>")).not.toThrow();
		expect(refusal("<box>\nx <align to=center>hi</align>\n</box>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("marks a raster line", () => {
		expect(needsRaster(build("<box>\nx\n</box>").nodes)).toBe(true);
	});
});
