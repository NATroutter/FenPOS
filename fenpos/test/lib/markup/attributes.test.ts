import { describe, expect, it } from "vitest";
import { type AttributeTable, readAttributes } from "@/lib/markup/attributes";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";

const TABLE: AttributeTable = {
	width: { kind: "integer", min: 1, max: 100 },
	border: { kind: "enum", values: ["single", "double", "thick", "none"] },
	title: { kind: "text", maxLength: 64 },
	lines: { kind: "integer", min: 1, max: 255, required: true },
	char: { kind: "char" },
};

const refusal = (work: () => unknown): MarkupError => {
	try {
		work();
	} catch (thrown) {
		if (thrown instanceof MarkupError) {
			return thrown;
		}
		throw thrown;
	}
	throw new Error("expected a refusal");
};

describe("readAttributes", () => {
	it("coerces integers and keeps enums and text as strings", () => {
		const read = readAttributes(
			"box",
			[
				{ name: "width", value: "60", column: 6 },
				{ name: "border", value: "double", column: 15 },
				{ name: "title", value: "Sales by hour", column: 29 },
				{ name: "lines", value: "3", column: 40 },
			],
			TABLE,
			2,
			1,
		);

		expect(read).toEqual({ width: 60, border: "double", title: "Sales by hour", lines: 3 });
	});

	it("refuses an attribute the tag does not declare, at its column", () => {
		const thrown = refusal(() => readAttributes("box", [{ name: "pad", value: "1", column: 6 }], TABLE, 4, 1));

		expect(thrown.code).toBe(MARKUP_ERRORS.unknownAttribute);
		expect(thrown.line).toBe(4);
		expect(thrown.column).toBe(6);
		expect(thrown.detail).toBe("pad");
	});

	it("refuses an integer outside its range", () => {
		const thrown = refusal(() => readAttributes("box", [{ name: "width", value: "0", column: 6 }], TABLE, 1, 1));

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.message).toMatch(/1 to 100/);
	});

	it("refuses a non-integer where an integer is declared", () => {
		expect(refusal(() => readAttributes("box", [{ name: "width", value: "6x", column: 6 }], TABLE, 1, 1)).code).toBe(
			MARKUP_ERRORS.invalidAttribute,
		);
	});

	it("refuses an enum value outside the set and names the set", () => {
		const thrown = refusal(() => readAttributes("box", [{ name: "border", value: "dotted", column: 6 }], TABLE, 1, 1));

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.message).toMatch(/single, double, thick or none/);
	});

	it("refuses text over its length", () => {
		expect(
			refusal(() => readAttributes("box", [{ name: "title", value: "x".repeat(65), column: 6 }], TABLE, 1, 1)).code,
		).toBe(MARKUP_ERRORS.invalidAttribute);
	});

	it("refuses the same attribute twice", () => {
		const thrown = refusal(() =>
			readAttributes(
				"box",
				[
					{ name: "width", value: "10", column: 6 },
					{ name: "width", value: "20", column: 15 },
				],
				TABLE,
				1,
				1,
			),
		);

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(15);
	});

	it("refuses a required attribute that was left off, at the tag's own column", () => {
		const thrown = refusal(() => readAttributes("feed", [], TABLE, 3, 5));

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.line).toBe(3);
		expect(thrown.column).toBe(5);
		expect(thrown.detail).toBe("lines");
		expect(thrown.message).toBe("<feed> requires lines");
	});

	it("matches an enum value ignoring case and keeps the table's spelling", () => {
		const read = readAttributes(
			"box",
			[
				{ name: "border", value: "Double", column: 6 },
				{ name: "lines", value: "1", column: 20 },
			],
			TABLE,
			1,
			1,
		);

		expect(read.border).toBe("double");
	});

	it("takes one character for a char attribute, counted in code points", () => {
		const read = readAttributes(
			"fill",
			[
				{ name: "char", value: "😀", column: 7 },
				{ name: "lines", value: "1", column: 14 },
			],
			TABLE,
			1,
			1,
		);

		expect(read.char).toBe("😀");
	});

	it("refuses a char attribute holding more than one character", () => {
		const thrown = refusal(() => readAttributes("fill", [{ name: "char", value: "ab", column: 7 }], TABLE, 1, 1));

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(7);
		expect(thrown.message).toBe("<fill> char=ab is not accepted; expected a single character");
	});

	it("treats an empty text value as though the attribute were left off", () => {
		const read = readAttributes(
			"box",
			[
				{ name: "title", value: "", column: 6 },
				{ name: "lines", value: "1", column: 15 },
			],
			TABLE,
			1,
			1,
		);

		expect(read).toEqual({ lines: 1 });
	});

	it("refuses a required text attribute written empty as missing", () => {
		const thrown = refusal(() =>
			readAttributes(
				"text",
				[{ name: "font", value: "", column: 7 }],
				{ font: { kind: "text", maxLength: 64, required: true } },
				1,
				1,
			),
		);

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(1);
		expect(thrown.detail).toBe("font");
		expect(thrown.message).toBe("<text> requires font");
	});

	it("refuses an attribute set twice even when the first was empty", () => {
		const thrown = refusal(() =>
			readAttributes(
				"box",
				[
					{ name: "title", value: "", column: 6 },
					{ name: "title", value: "A", column: 15 },
				],
				TABLE,
				1,
				1,
			),
		);

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.column).toBe(15);
		expect(thrown.message).toBe("<box> sets 'title' twice");
	});

	it("still refuses an empty value that is not text", () => {
		const thrown = refusal(() => readAttributes("box", [{ name: "width", value: "", column: 6 }], TABLE, 1, 1));

		expect(thrown.code).toBe(MARKUP_ERRORS.invalidAttribute);
		expect(thrown.message).toBe("<box> width= is not accepted; expected a whole number from 1 to 100");
	});
});
