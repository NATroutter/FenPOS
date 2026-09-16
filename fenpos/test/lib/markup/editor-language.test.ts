import { describe, expect, it } from "vitest";
import {
	attributeSuggestions,
	closingFor,
	contextAt,
	renamePairFor,
	tagSuggestions,
	valueSuggestions,
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

	it("reports the enclosing open tags outside a header", () => {
		const source = "<table>\n<row>\n";
		const context = contextAt(source, source.length);

		expect(context.open).toEqual(["table", "row"]);
		expect(context.inHeader).toBe(false);
	});
});

describe("tagSuggestions", () => {
	it("offers only row inside a table", () => {
		expect(labels(tagSuggestions(contextAt("<table>\n", 8)))).toEqual(["row"]);
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

		expect(suggestions).toEqual([{ label: "", detail: "a whole number from 1 to 8" }]);
	});

	it("offers nothing for a free-text value", () => {
		const source = "<chart title=";

		expect(valueSuggestions(contextAt(source, source.length))).toEqual([]);
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
