import { describe, expect, it } from "vitest";
import {
	attributeSuggestions,
	closingFor,
	closingSuggestions,
	contextAt,
	entityAt,
	headerNameAt,
	maySuggest,
	renameEditsFor,
	renamePairFor,
	suggestionsFor,
	tagSuggestions,
	valueSuggestions,
	variableAt,
	variableSuggestions,
} from "@/lib/markup/editor-language";
import { REQUIRED_PARENT, TAGS } from "@/lib/markup/tags";

const labels = (suggestions: { label: string }[]): string[] => suggestions.map((suggestion) => suggestion.label).sort();

describe("contextAt", () => {
	it("reports the tag whose header the caret sits in", () => {
		const source = "<align to=center>";
		const context = contextAt(source, "<align ".length);

		expect(context.tag).toBe("align");
		expect(context.inHeader).toBe(true);
		expect(context.inValue).toBe(false);
	});

	it("reports the attribute whose value the caret sits in", () => {
		const source = "<align to=center>";
		const context = contextAt(source, "<align to=cen".length);

		expect(context.attribute).toBe("to");
		expect(context.inValue).toBe(true);
	});

	it("reports the attribute whose value the caret sits in when tags are written after it", () => {
		const source = '<align to="">\n<bold>x</bold>\n</align>';
		const context = contextAt(source, '<align to="'.length);

		expect(context.attribute).toBe("to");
		expect(context.inValue).toBe(true);
	});

	it("reports the enclosing open tags outside a header", () => {
		const source = "<table>\n<row>\n";
		const context = contextAt(source, source.length);

		expect(context.open).toEqual(["table", "row"]);
		expect(context.inHeader).toBe(false);
	});

	it("reports the enclosing open tags inside a block that is already closed", () => {
		const source = "<table>\n\n</table>";
		const context = contextAt(source, "<table>\n".length);

		expect(context.open).toEqual(["table"]);
	});

	it("reports a caret that is still on the tag name", () => {
		expect(contextAt("<size", 5).onTagName).toBe(true);
		expect(contextAt("<size ", 6).onTagName).toBe(false);
		expect(contextAt("<size width=2", 13).onTagName).toBe(false);
	});
});

describe("entityAt", () => {
	it("finds an entity still being typed", () => {
		expect(entityAt("a&am", 4)).toBe(1);
		expect(entityAt("&", 1)).toBe(0);
	});

	it("finds none once the semicolon is written", () => {
		expect(entityAt("a&amp;", 6)).toBeNull();
	});

	it("finds none where no ampersand precedes the caret", () => {
		expect(entityAt("plain", 5)).toBeNull();
	});

	it("finds none where the ampersand is separated from the caret by other text", () => {
		expect(entityAt("Fish & Chips", 12)).toBeNull();
	});
});

describe("variableAt", () => {
	it("finds a reference with nothing typed into it yet", () => {
		expect(variableAt("Call {", 6)).toEqual({ from: 6, to: 6, terminated: false });
	});

	it("finds one part-way through its name", () => {
		expect(variableAt("Call {pho", 9)).toEqual({ from: 6, to: 9, terminated: false });
	});

	it("reports the closing brace when it is already written", () => {
		expect(variableAt("Call {pho}", 9)).toEqual({ from: 6, to: 9, terminated: true });
	});

	/** The whole name, not the half before the caret: a completion changes the name rather than doubling it. */
	it("runs to the end of the name the caret stands in", () => {
		expect(variableAt("Call {phone}", "Call {ph".length)).toEqual({ from: 6, to: 11, terminated: true });
	});

	it("finds none where the braces hold something that is not a name", () => {
		// The rule that keeps `Table {1 of 4}` printable without an escape.
		expect(variableAt("Table {1 of", 11)).toBeNull();
	});

	it("finds none past a reference that is already closed", () => {
		expect(variableAt("{phone} and", 11)).toBeNull();
	});

	it("finds none where no brace precedes the caret", () => {
		expect(variableAt("plain text", 10)).toBeNull();
	});

	it("finds none where the brace is on the line above", () => {
		expect(variableAt("{\nphone", 7)).toBeNull();
	});

	it("finds none where the name is longer than a name may be", () => {
		const long = "a".repeat(65);

		expect(variableAt(`{${long}`, long.length + 1)).toBeNull();
	});
});

describe("variableSuggestions", () => {
	it("offers each variable with its note beside it", () => {
		expect(
			variableSuggestions([
				{ name: "phone", detail: "Shop phone" },
				{ name: "today", detail: "a date or time" },
			]),
		).toEqual([
			{ label: "phone", detail: "Shop phone", kind: "variable" },
			{ label: "today", detail: "a date or time", kind: "variable" },
		]);
	});

	it("leaves a variable with no note to stand on its name", () => {
		expect(variableSuggestions([{ name: "phone", detail: null }])).toEqual([{ label: "phone", kind: "variable" }]);
	});

	it("offers nothing where the install defines none, which is also how it answers with variables off", () => {
		expect(variableSuggestions([])).toEqual([]);
	});
});

/**
 * The guard the editor asks after a deletion, before it asks again what may be written.
 *
 * Worth pinning on its own because it is what decides whether backspacing through a value says
 * anything at all: the editor went silent exactly there before, and a change to `contextAt` that
 * narrowed `inHeader` would put it back without a suggestion source ever being consulted.
 */
describe("maySuggest", () => {
	it("says yes inside a header, wherever in it the caret is", () => {
		expect(maySuggest("<align to=center>", "<align".length)).toBe(true);
		expect(maySuggest("<align to=center>", "<align to=cent".length)).toBe(true);
	});

	/** The position that was silent: the whole value deleted, with every value on offer. */
	it("says yes with the value deleted away to nothing", () => {
		expect(maySuggest("<align to=>", "<align to=".length)).toBe(true);
	});

	it("says yes inside an entity being typed", () => {
		expect(maySuggest("a&am", 4)).toBe(true);
	});

	it("says yes inside a variable reference being typed", () => {
		expect(maySuggest("Call {pho", 9)).toBe(true);
	});

	it("says no in ordinary text", () => {
		expect(maySuggest("Coffee 2.50", 6)).toBe(false);
	});

	it("says no once the header is closed behind the caret", () => {
		expect(maySuggest("<bold>x", 7)).toBe(false);
	});

	it("reads one line, since that is all the editor hands it", () => {
		// A header opened on the line above is not this line's business: the scanner bounds a tag at the
		// line's own end, so a caret here is in ordinary text whatever stands above it.
		expect(maySuggest("plain text", 5)).toBe(false);
	});
});

describe("tagSuggestions", () => {
	it("offers only row inside a table", () => {
		expect(labels(tagSuggestions(contextAt("<table>\n", 8)))).toEqual(["row"]);
	});

	it("offers only row inside a table that is already closed", () => {
		const source = "<table>\n\n</table>";

		expect(labels(tagSuggestions(contextAt(source, "<table>\n".length)))).toEqual(["row"]);
	});

	it("offers only cell inside a row", () => {
		expect(labels(tagSuggestions(contextAt("<table>\n<row>\n", 14)))).toEqual(["cell"]);
	});

	it("offers series and labels inside a chart", () => {
		expect(labels(tagSuggestions(contextAt("<chart type=bar>\n", 17)))).toEqual(["labels", "series"]);
	});

	it("offers no printer-drawn tag inside a block", () => {
		const inside = labels(tagSuggestions(contextAt("<box>\n", 6)));

		expect(inside).not.toContain("qr");
		expect(inside).not.toContain("cut");
		expect(inside).toContain("bold");
	});

	it("offers no printer-drawn tag inside a block that is already closed", () => {
		const inside = labels(tagSuggestions(contextAt("<box>\n\n</box>", "<box>\n".length)));

		expect(inside).not.toContain("qr");
		expect(inside).not.toContain("cut");
		expect(inside).toContain("bold");
	});

	it("offers every tag that can stand on its own at the top level", () => {
		const standalone = Object.keys(TAGS)
			.filter((name) => !REQUIRED_PARENT.has(name))
			.sort();

		expect(labels(tagSuggestions(contextAt("", 0)))).toEqual(standalone);
	});

	it("offers no tag that needs a parent at the top level", () => {
		const top = labels(tagSuggestions(contextAt("", 0)));

		expect(top).not.toContain("row");
		expect(top).not.toContain("cell");
		expect(top).not.toContain("series");
		expect(top).not.toContain("labels");
	});
});

describe("attributeSuggestions", () => {
	it("offers the tag's own attributes", () => {
		const source = "<size ";

		expect(labels(attributeSuggestions(contextAt(source, source.length), source))).toEqual(["height", "width"]);
	});

	it("drops an attribute already written on the tag", () => {
		const source = "<size width=2 ";

		expect(labels(attributeSuggestions(contextAt(source, source.length), source))).toEqual(["height"]);
	});

	/**
	 * The tripwire: an attribute added to the registry is offered without anyone remembering to add a
	 * case here, and one the editor cannot reach fails this rather than going unnoticed.
	 */
	it("offers exactly the attributes the registry declares, for every tag", () => {
		for (const [name, tag] of Object.entries(TAGS)) {
			const declared = Object.keys(tag.attributes).sort();
			if (declared.length === 0) {
				continue;
			}
			const source = `<${name} `;

			expect(labels(attributeSuggestions(contextAt(source, source.length), source)), name).toEqual(declared);
		}
	});
});

describe("valueSuggestions", () => {
	it("offers an enum's values", () => {
		const source = "<align to=";

		expect(labels(valueSuggestions(contextAt(source, source.length)))).toEqual(["center", "left", "right"]);
	});

	it("describes an integer's range rather than listing it", () => {
		const source = "<size width=";
		const suggestions = valueSuggestions(contextAt(source, source.length));

		expect(suggestions).toEqual([{ label: "", detail: "a whole number from 1 to 8", kind: "value" }]);
	});

	it("offers nothing for a free-text value", () => {
		const source = "<chart title=";

		expect(valueSuggestions(contextAt(source, source.length))).toEqual([]);
	});

	it("offers the printer's own faces for a font, with no install to ask", () => {
		const source = "<text font=";

		expect(labels(valueSuggestions(contextAt(source, source.length)))).toEqual(["a", "b"]);
	});

	it("offers the stored fonts after them", () => {
		const source = "<text font=";
		const offered = valueSuggestions(contextAt(source, source.length), { fonts: ["receipt-mono", "headline"] });

		expect(offered.map((one) => one.label)).toEqual(["a", "b", "receipt-mono", "headline"]);
		expect(offered.every((one) => one.kind === "value")).toBe(true);
	});

	it("says which of the two kinds a font is, since only one of them takes a size", () => {
		const source = "<text font=";
		const offered = valueSuggestions(contextAt(source, source.length), { fonts: ["receipt-mono"] });

		expect(offered[0].detail).toMatch(/printer/);
		expect(offered[2].detail).toMatch(/stored/);
	});

	/**
	 * A stored asset may legitimately be called `a`: the asset namespace and the printer's faces are
	 * different namespaces and neither reserves the other's names. The parser resolves the built-in
	 * first, so offering the name twice would offer a choice the author does not have.
	 */
	it("does not offer a name twice when a stored font shadows a built-in one", () => {
		const source = "<text font=";

		expect(labels(valueSuggestions(contextAt(source, source.length), { fonts: ["a", "serif"] }))).toEqual([
			"a",
			"b",
			"serif",
		]);
	});

	it("offers nothing extra for the other text attributes", () => {
		for (const source of ["<chart title=", "<series name="]) {
			expect(valueSuggestions(contextAt(source, source.length), { fonts: ["receipt-mono"] }), source).toEqual([]);
		}
	});
});

/**
 * What each suggestion is, which is what the editor turns the `=` on.
 *
 * An attribute's name is half of `name=value`, so accepting one writes the `=` and asks again; a tag
 * name and a value are complete as they stand. Nothing else distinguishes the three — they are all
 * words offered in a header — so a producer that forgot its kind would silently stop the value
 * suggestions from following.
 */
describe("suggestion kinds", () => {
	it("marks tag names", () => {
		expect(tagSuggestions(contextAt("", 0)).every((suggestion) => suggestion.kind === "tag")).toBe(true);
	});

	it("marks attribute names", () => {
		const source = "<size ";

		expect(attributeSuggestions(contextAt(source, source.length), source)).toEqual([
			{ label: "width", detail: "a whole number from 1 to 8", kind: "attribute" },
			{ label: "height", detail: "a whole number from 1 to 8", kind: "attribute" },
		]);
	});

	it("marks values", () => {
		const source = "<align to=";

		expect(valueSuggestions(contextAt(source, source.length)).every((one) => one.kind === "value")).toBe(true);
	});

	it("carries the kind through suggestionsFor, which is what the editor actually reads", () => {
		const header = "<size ";
		const value = "<align to=";

		expect(suggestionsFor(contextAt("<siz", 4), "<siz")[0].kind).toBe("tag");
		expect(suggestionsFor(contextAt(header, header.length), header)[0].kind).toBe("attribute");
		expect(suggestionsFor(contextAt(value, value.length), value)[0].kind).toBe("value");
	});
});

describe("closingSuggestions", () => {
	it("offers the innermost open tag", () => {
		const source = "<box>\n<bold>x</";

		expect(closingSuggestions(contextAt(source, source.length))).toEqual([
			{ label: "bold", detail: "the innermost open tag", kind: "closing" },
		]);
	});

	it("offers the outer tag again once the inner one is closed", () => {
		const source = "<box>\n<bold>x</bold>\n</";

		expect(labels(closingSuggestions(contextAt(source, source.length)))).toEqual(["box"]);
	});

	it("offers nothing when nothing is open", () => {
		expect(closingSuggestions(contextAt("plain</", 7))).toEqual([]);
	});

	it("offers nothing for a void tag, which never opened anything", () => {
		const source = "<hr>\n</";

		expect(closingSuggestions(contextAt(source, source.length))).toEqual([]);
	});
});

describe("suggestionsFor, in a closing tag", () => {
	it("answers a bare </ with the tag it closes", () => {
		const source = "<text font=a>Hi</";

		expect(labels(suggestionsFor(contextAt(source, source.length), source))).toEqual(["text"]);
	});

	it("still answers once part of the name is typed", () => {
		const source = "<text font=a>Hi</te";

		expect(labels(suggestionsFor(contextAt(source, source.length), source))).toEqual(["text"]);
	});

	it("does not offer the registry, the way an opening tag is offered it", () => {
		const opening = "<";
		const closing = "<box>\n</";

		expect(labels(suggestionsFor(contextAt(opening, 1), opening)).length).toBeGreaterThan(1);
		expect(labels(suggestionsFor(contextAt(closing, closing.length), closing))).toEqual(["box"]);
	});

	/** A closing tag takes its `>` straight after the name; anything between is refused. */
	it("offers nothing past the name, where an opening tag would offer attributes", () => {
		const closing = "<size width=2>x</size ";
		const opening = "<size ";

		expect(suggestionsFor(contextAt(closing, closing.length), closing)).toEqual([]);
		expect(labels(suggestionsFor(contextAt(opening, opening.length), opening))).toEqual(["height", "width"]);
	});
});

describe("closingFor", () => {
	it("closes a paired tag", () => {
		expect(closingFor("<bold>", 6)).toBe("</bold>");
	});

	it("does not close a void tag", () => {
		expect(closingFor("<hr>", 4)).toBeNull();
	});

	it("does not close an unknown tag", () => {
		expect(closingFor("<nope>", 6)).toBeNull();
	});

	it("does not close a tag that already has its closing tag", () => {
		expect(closingFor("<bold>a</bold>", 6)).toBeNull();
	});

	it("does not close from inside a quoted value", () => {
		const source = '<chart title="a > b">';

		expect(closingFor(source, source.indexOf(">") + 1)).toBeNull();
	});

	it("does not take the name of an earlier tag for a header that has none", () => {
		const source = "<bold>x\n<>";

		expect(closingFor(source, source.length)).toBeNull();
	});
});

describe("headerNameAt", () => {
	/** Where the name is, for a line holding one tag, with the caret written as `|`. */
	const nameAt = (marked: string): { from: number; to: number } | null => {
		const at = marked.indexOf("|");
		return headerNameAt(marked.replace("|", ""), at);
	};

	it("finds the name from anywhere inside the header", () => {
		expect(nameAt("<|bold>")).toEqual({ from: 1, to: 5 });
		expect(nameAt("<bo|ld>")).toEqual({ from: 1, to: 5 });
		expect(nameAt("<bold|>")).toEqual({ from: 1, to: 5 });
	});

	it("finds the name from inside a closing tag", () => {
		expect(nameAt("</bo|ld>")).toEqual({ from: 2, to: 6 });
	});

	it("finds the name past an attribute", () => {
		expect(nameAt("<cell align=cen|ter>")).toEqual({ from: 1, to: 5 });
	});

	it("takes the caret just after the header, and not the one just before it", () => {
		expect(nameAt("<bold>|")).toEqual({ from: 1, to: 5 });
		expect(nameAt("|<bold>")).toBeNull();
	});

	it("finds the name of a header still being typed", () => {
		expect(nameAt("<bol|")).toEqual({ from: 1, to: 4 });
	});

	it("gives nothing for a caret in ordinary text", () => {
		expect(nameAt("<bold>te|xt</bold>")).toBeNull();
	});

	it("reads the header the caret is in, not one written before it", () => {
		expect(nameAt("<bold>x</bold> <inv|ert>")).toEqual({ from: 16, to: 22 });
	});

	it("gives nothing for a header with no name", () => {
		expect(nameAt("<|>")).toBeNull();
	});
});

describe("renamePairFor", () => {
	it("finds the closing name for an opening one", () => {
		const source = "<bold>a</bold>";
		const pair = renamePairFor(source, 2);

		expect(pair).toEqual({ from: source.indexOf("</bold>") + 2, to: source.length - 1 });
	});

	it("pairs by nesting depth", () => {
		const source = "<box>\n<box border=none>\nA\n</box>\n</box>";
		const inner = renamePairFor(source, source.indexOf("<box border") + 2);

		expect(inner).toEqual({ from: source.indexOf("</box>") + 2, to: source.indexOf("</box>") + 5 });
	});

	it("gives nothing when the document is unbalanced", () => {
		expect(renamePairFor("<bold>a", 2)).toBeNull();
	});
});

describe("suggestionsFor", () => {
	it("offers tags while the caret is still on the tag name", () => {
		const source = "<size";
		const offered = labels(suggestionsFor(contextAt(source, source.length), source));

		expect(offered).toContain("size");
		expect(offered).not.toContain("width");
	});

	it("offers attributes once the name is behind the caret", () => {
		const source = "<size ";

		expect(labels(suggestionsFor(contextAt(source, source.length), source))).toEqual(["height", "width"]);
	});

	it("offers an enum's values inside a value", () => {
		const source = "<align to=";

		expect(labels(suggestionsFor(contextAt(source, source.length), source))).toEqual(["center", "left", "right"]);
	});

	it("offers an enum's values inside a value with a closed tag after the caret", () => {
		const source = '<align to="">\n</align>';
		const context = contextAt(source, '<align to="'.length);

		expect(labels(suggestionsFor(context, source))).toEqual(["center", "left", "right"]);
	});

	it("offers nothing outside a header", () => {
		expect(suggestionsFor(contextAt("hello", 5), "hello")).toEqual([]);
	});
});

describe("renameEditsFor", () => {
	const source = "<bold></bold>";
	const nameEnd = "<bold".length;
	const partner = { from: "<bold></".length, to: "<bold></bold".length };

	it("rewrites the partner as a name character is typed", () => {
		const edits = renameEditsFor(source, [{ from: nameEnd, to: nameEnd, insert: "x" }]);

		expect(edits).toEqual([{ from: partner.from, to: partner.to, insert: "boldx" }]);
	});

	it("rewrites the partner as a name character is deleted", () => {
		const edits = renameEditsFor(source, [{ from: nameEnd - 1, to: nameEnd, insert: "" }]);

		expect(edits).toEqual([{ from: partner.from, to: partner.to, insert: "bol" }]);
	});

	it("leaves the partner alone when a space begins an attribute", () => {
		expect(renameEditsFor(source, [{ from: nameEnd, to: nameEnd, insert: " " }])).toEqual([]);
	});

	it("leaves the partner alone when a bracket ends the header", () => {
		expect(renameEditsFor(source, [{ from: nameEnd, to: nameEnd, insert: ">" }])).toEqual([]);
	});

	it("leaves the partner alone when an attribute is assigned", () => {
		expect(renameEditsFor(source, [{ from: nameEnd, to: nameEnd, insert: "=" }])).toEqual([]);
	});

	it("leaves both names alone when one change edits each of them", () => {
		const both = [
			{ from: nameEnd, to: nameEnd, insert: "x" },
			{ from: partner.to, to: partner.to, insert: "x" },
		];

		expect(renameEditsFor(source, both)).toEqual([]);
	});
});
