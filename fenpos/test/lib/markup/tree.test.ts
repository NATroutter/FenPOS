import { describe, expect, it } from "vitest";
import { DEFAULT_PARSE_OPTIONS, type Document, type Node } from "@/lib/markup/document";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
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
});
