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
		expect(build("<size=2,3>a</size>").nodes[0]).toMatchObject({ patch: { widthMult: 2, heightMult: 3 } });
		expect(build("<size=2>a</size>").nodes[0]).toMatchObject({ patch: { widthMult: 2, heightMult: 2 } });
		expect(refusal("<size=9>a</size>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("lets align span several lines when it owns each of them", () => {
		const document = build("<align=center>a\nb</align>");

		expect(document.nodes[0]).toMatchObject({ kind: "align", align: "CENTER" });
		expect(kinds((document.nodes[0] as { children: Node[] }).children)).toEqual(["text", "break", "text"]);
	});

	it("refuses align opened after text on the same line", () => {
		const thrown = refusal("x <align=center>a</align>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAlignScope);
		expect(thrown.column).toBe(3);
	});

	it("refuses align opened after text on an earlier line inside a scope", () => {
		expect(refusal("<bold>x\n<align=center>a</align></bold>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("refuses text after align closes on the same line", () => {
		// The space is the first thing that follows the close, so it is what is pointed at.
		const thrown = refusal("<align=center>a</align> b");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAlignScope);
		expect(thrown.column).toBe(24);
	});

	it("allows the next line to start fresh after align closes", () => {
		expect(kinds(build("<align=center>a</align>\nb").nodes)).toEqual(["align", "break", "text"]);
	});

	it("refuses a second align while one is open", () => {
		expect(refusal("<align=center>a\n<align=left>b</align></align>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("names the tag being opened when a second align follows the first on one line", () => {
		const thrown = refusal("<align=center>a</align><align=left>b</align>");

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAlignScope);
		expect(thrown.detail).toBe("align");
		expect(thrown.column).toBe(24);
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
		const document = build("<align=center><qr>https://x</qr></align>");

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
		expect(build("<image=50>logo</image>").nodes[0]).toMatchObject({ kind: "image", widthPercent: 50 });
	});

	it("refuses a control character in a symbol's content through the tokenizer", () => {
		expect(refusal("<qr>a</qr>").code).toBe(MARKUP_ERRORS.controlCharacter);
	});

	it("resolves void tags into directives", () => {
		const document = build("<cut=partial><feed=3><drawer=5>");

		expect(document.nodes).toEqual([
			{ kind: "void", directive: { kind: "CUT", mode: "PARTIAL" }, line: 1, column: 1 },
			{ kind: "void", directive: { kind: "FEED", lines: 3 }, line: 1, column: 14 },
			{ kind: "void", directive: { kind: "DRAWER", pin: 5 }, line: 1, column: 22 },
		]);
	});

	it("keeps a fill with its character", () => {
		expect(build("a<fill=.>b").nodes[1]).toEqual({ kind: "fill", character: ".", line: 1, column: 2 });
	});

	/** A fill places something on the line, so the line is no longer a fresh one an align could own. */
	it("refuses align opened after a fill on the same line", () => {
		expect(refusal("<fill><align=center>x</align>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
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
		expect(build("<font=b>x</font>").nodes[0]).toMatchObject({ patch: { font: "B", face: null } });
		const thrown = refusal("<font=a size=30>x</font>");
		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(9);
	});

	it("resolves a configured font with a size", () => {
		expect(build("<font=roboto size=36>x</font>").nodes[0]).toMatchObject({ patch: { face: "roboto", faceDots: 36 } });
		expect(build("<font=roboto>x</font>").nodes[0]).toMatchObject({ patch: { face: "roboto", faceDots: 24 } });
	});

	it("bounds the font size by the parse options", () => {
		const generous = buildDocument(tokenize("<font=roboto size=600>x</font>", null), {
			...DEFAULT_PARSE_OPTIONS,
			maxFontHeight: 1024,
		});
		expect(generous.nodes[0]).toMatchObject({ patch: { faceDots: 600 } });
		expect(refusal("<font=roboto size=600>x</font>").code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(refusal("<font=roboto size=7>x</font>").code).toBe(MARKUP_ERRORS.invalidAttribute);
	});

	it("refuses a font name that is not a name", () => {
		expect(refusal("<font=Roboto>x</font>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
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
		expect(refusal("<align=center><bar=50></align>  ").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("still refuses trailing whitespace after a wrap closes, even when a gauge shared its line", () => {
		expect(refusal("<nowrap><bar=50></nowrap>  ").code).toBe(MARKUP_ERRORS.invalidWrapScope);
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
			"<chart=bar height=8>\n<series=Sales pattern=hatch>1,2,3</series>\n<labels>a,b,c</labels>\n</chart>",
		) as BlockNode;

		expect(chart.argument).toBe("bar");
		expect(chart.children.filter((node) => node.kind === "block").map((node) => (node as BlockNode).content)).toEqual([
			"1,2,3",
			"a,b,c",
		]);
		expect(refusal("<chart=bar>\ntext\n</chart>").code).toBe(MARKUP_ERRORS.misplacedBlock);
		expect(refusal("<chart=bar>\n<bar=10>\n</chart>").code).toBe(MARKUP_ERRORS.misplacedBlock);
		expect(refusal("<chart=donut>\n</chart>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
		expect(refusal("<chart=bar area=on>\n</chart>").code).toBe(MARKUP_ERRORS.invalidAttribute);
	});

	it("parses series values, scatter pairs and labels", () => {
		const chart = block(
			"<chart=scatter>\n<series=A>1:2, 3:4\n5:6</series>\n<labels>x,y</labels>\n</chart>",
		) as BlockNode;

		expect(chart.chart?.series[0].points).toEqual([
			[1, 2],
			[3, 4],
			[5, 6],
		]);
		expect(chart.chart?.labels).toEqual(["x", "y"]);
		expect(chart.chart?.series[0].marker).toBe("circle");
	});

	it("refuses a value that is not a number, too many points and too many labels", () => {
		expect(refusal("<chart=bar>\n<series>1,two</series>\n</chart>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
		expect(refusal("<chart=bar>\n<series>1,2</series>\n<labels>a,b,c</labels>\n</chart>").code).toBe(
			MARKUP_ERRORS.tooManyLabels,
		);
		const many = Array.from({ length: 2001 }, (_, index) => index).join(",");
		expect(refusal(`<chart=line>\n<series>${many}</series>\n</chart>`).code).toBe(MARKUP_ERRORS.tooManyPoints);
	});

	it("requires one series for a pie and at least one series for any chart", () => {
		expect(refusal("<chart=pie>\n<series>1</series>\n<series>2</series>\n</chart>").code).toBe(
			MARKUP_ERRORS.invalidTagArgument,
		);
		expect(refusal("<chart=bar>\n</chart>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
	});

	it("assigns patterns and markers by order", () => {
		const chart = block(
			"<chart=bar>\n<series>1</series>\n<series>2</series>\n<series>3</series>\n<series>4</series>\n<series>5</series>\n</chart>",
		) as BlockNode;

		expect(chart.chart?.series.map((series) => series.pattern)).toEqual(["solid", "hatch", "dot", "hollow", "solid"]);
	});

	it("allows a marker only on a chart that plots points", () => {
		expect(() => build("<chart=scatter>\n<series marker=cross>1:2,3:4</series>\n</chart>")).not.toThrow();

		const thrown = refusal("<chart=pie>\n<series marker=cross>1,2</series>\n</chart>");
		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.line).toBe(2);
	});

	it("reads the gauge", () => {
		expect(block("<bar=38 width=80>")).toMatchObject({
			kind: "block",
			tag: "bar",
			argument: "38",
			attributes: { width: 80 },
		});
		expect(refusal("<bar=101>").code).toBe(MARKUP_ERRORS.invalidTagArgument);
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
		expect(() => build("<box>\n<align=center>hi</align>\n</box>")).not.toThrow();
		expect(refusal("<box>\nx <align=center>hi</align>\n</box>").code).toBe(MARKUP_ERRORS.invalidAlignScope);
	});

	it("marks a raster line", () => {
		expect(needsRaster(build("<box>\nx\n</box>").nodes)).toBe(true);
	});
});
