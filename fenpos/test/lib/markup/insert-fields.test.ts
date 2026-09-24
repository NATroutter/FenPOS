import { describe, expect, it } from "vitest";
import { applies, fieldsFor, type InsertControl } from "@/lib/markup/insert-fields";
import { REQUIRED_PARENT, TAGS } from "@/lib/markup/tags";

/**
 * The controls the Insert dialog builds itself from the tag registry.
 *
 * The point of the derivation is that nothing here is written down twice, so most of what follows is
 * about the registry and the dialog staying in step rather than about any one tag.
 */

describe("fieldsFor", () => {
	it("offers a dropdown for an attribute with a fixed set of values", () => {
		expect(fieldsFor("align")).toEqual([
			{ name: "to", label: "To", required: true, kind: "select", values: ["LEFT", "CENTER", "RIGHT"] },
		]);
	});

	it("offers a bounded number for an integer, with the registry's own bounds", () => {
		expect(fieldsFor("feed")).toEqual([
			{ name: "lines", label: "Lines", required: true, kind: "number", min: 1, max: 255 },
		]);
	});

	it("offers a single-character box for a char", () => {
		expect(fieldsFor("fill")).toEqual([{ name: "char", label: "Char", required: false, kind: "char" }]);
	});

	/** The one attribute whose values only this install knows, which is why it has a kind of its own. */
	it("marks a font apart from ordinary text, so the dialog can offer what is stored", () => {
		const [font, size] = fieldsFor("text");

		expect(font).toEqual({ name: "font", label: "Font", required: true, kind: "font", maxLength: 64 });
		expect(size.kind).toBe("number");
	});

	it("offers a plain box for text that names nothing", () => {
		const title = fieldsFor("chart").find((field) => field.name === "title");

		expect(title).toEqual({ name: "title", label: "Title", required: false, kind: "text", maxLength: 64 });
	});

	/** Declaration order: a tag's table leads with the attribute that matters most. */
	it("keeps the order the registry declares", () => {
		expect(fieldsFor("chart").map((field) => field.name)).toEqual([
			"type",
			"width",
			"height",
			"title",
			"legend",
			"area",
		]);
	});

	it("offers nothing for a tag that takes no attributes", () => {
		expect(fieldsFor("bold")).toEqual([]);
	});

	it("offers nothing for a name no tag has", () => {
		expect(fieldsFor("nonesuch")).toEqual([]);
	});

	/**
	 * The tripwire. An attribute added to any tag reaches the dialog without anyone remembering to
	 * add it, and one the dialog could not render fails here rather than rendering as a blank gap.
	 */
	it("builds a control for every attribute of every tag", () => {
		const kinds = new Set<string>();

		for (const [name, tag] of Object.entries(TAGS)) {
			const fields = fieldsFor(name);

			expect(
				fields.map((field) => field.name),
				name,
			).toEqual(Object.keys(tag.attributes));
			for (const field of fields) {
				expect(field.label.length, `${name} ${field.name}`).toBeGreaterThan(0);
				kinds.add(field.kind);
			}
		}

		// Every kind of control the dialog knows how to draw is reached by some real tag, so none of
		// them is code nothing exercises.
		expect([...kinds].sort()).toEqual(["char", "font", "number", "select", "text"]);
	});
});

/**
 * The controls that are only worth showing beside certain answers.
 *
 * Each of these is markup the dialog used to be able to write and the parser refuses on sight —
 * `<chart type=bar area=on>`, `<text font=a size=12>` — reachable because the dialog derived its
 * controls from what a tag *has* while the combinations a tag *allows* were checked somewhere the
 * dialog could not see. Now both read one declaration, so a case here failing means the rule moved
 * rather than that the dialog fell behind it.
 */
describe("applies", () => {
	const field = (tag: string, name: string): InsertControl => {
		const found = fieldsFor(tag).find((control) => control.name === name);
		if (!found) {
			throw new Error(`<${tag}> has no ${name}`);
		}
		return found;
	};

	it("keeps a chart's area fill for a line chart", () => {
		expect(applies(field("chart", "area"), { type: "line" })).toBe(true);
	});

	it("drops it for every other kind of chart", () => {
		expect(applies(field("chart", "area"), { type: "bar" })).toBe(false);
		expect(applies(field("chart", "area"), { type: "pie" })).toBe(false);
		expect(applies(field("chart", "area"), { type: "scatter" })).toBe(false);
	});

	it("drops a font size for the printer's own faces, however they are spelled", () => {
		expect(applies(field("text", "size"), { font: "a" })).toBe(false);
		expect(applies(field("text", "size"), { font: "B" })).toBe(false);
	});

	it("keeps it for a stored font", () => {
		expect(applies(field("text", "size"), { font: "roboto" })).toBe(true);
	});

	/** A series is collected beside the chart it belongs to, so its chart's type is already in hand. */
	it("drops a series marker on a chart that plots no points", () => {
		expect(applies(field("series", "marker"), { type: "bar" })).toBe(false);
		expect(applies(field("series", "marker"), { type: "line" })).toBe(true);
		expect(applies(field("series", "marker"), { type: "scatter" })).toBe(true);
	});

	it("keeps a control that depends on nothing, whatever else was answered", () => {
		expect(applies(field("chart", "title"), {})).toBe(true);
		expect(applies(field("chart", "title"), { type: "bar" })).toBe(true);
	});

	/**
	 * The tripwire for the declarations themselves. A condition naming an attribute that does not
	 * exist is a rule that can never be met or never be broken, depending on which way it is written,
	 * and neither failure is visible from the markup it silently mis-handles.
	 */
	it("depends only on attributes the tag or its parent declares", () => {
		for (const [name, tag] of Object.entries(TAGS)) {
			for (const field of fieldsFor(name)) {
				const condition = field.appliesWhen;
				if (!condition) {
					continue;
				}

				const parent = REQUIRED_PARENT.get(name);
				const owner = condition.on === "parent" ? (parent ? TAGS[parent] : undefined) : tag;

				expect(owner, `<${name}> ${field.name}`).toBeDefined();
				expect(Object.keys(owner?.attributes ?? {}), `<${name}> ${field.name}`).toContain(condition.attribute);
				expect(condition.is ?? condition.isNot, `<${name}> ${field.name}`).toBeDefined();
				expect(condition.because.length, `<${name}> ${field.name}`).toBeGreaterThan(0);
			}
		}
	});
});
