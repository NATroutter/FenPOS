import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";

/** What one attribute accepts, and whether the tag can do without it. */
export type AttributeSpec = (
	| { kind: "integer"; min: number; max: number }
	| { kind: "enum"; values: readonly string[] }
	| { kind: "text"; maxLength: number }
	| { kind: "char" }
) & {
	/** The tag means nothing without this attribute, so leaving it off is refused. */
	required?: true;
};

/** The attributes a tag declares, by lowercase name. An empty table means the tag takes none. */
export type AttributeTable = Readonly<Record<string, AttributeSpec>>;

/** An attribute as the tokenizer read it, before it is checked against a table. */
export interface RawAttribute {
	name: string;
	value: string;
	column: number;
}

/** Attributes after validation: integers coerced, everything else kept as written. */
export type Attributes = Readonly<Record<string, string | number>>;

const INTEGER = /^-?\d+$/;

/**
 * Checks a tag's attributes against its table.
 *
 * Every refusal names the attribute. A bad value points at the attribute's own column, because a
 * tag can carry several and "invalid attribute on line 3" would send the author counting; a
 * missing one has no column of its own and points at the tag.
 *
 * @param tag the tag's name, for the message
 * @param raw the attributes as the tokenizer read them
 * @param table what this tag declares
 * @param line the tag's line
 * @param column the tag's column, where a missing required attribute is reported
 */
export function readAttributes(
	tag: string,
	raw: readonly RawAttribute[],
	table: AttributeTable,
	line: number,
	column: number,
): Attributes {
	const read: Record<string, string | number> = {};
	// What was written, apart from what was kept: an empty text value is kept as nothing, and a second
	// one of the same name is still a second one.
	const seen = new Set<string>();

	for (const attribute of raw) {
		const spec = Object.hasOwn(table, attribute.name) ? table[attribute.name] : undefined;
		if (!spec) {
			throw new MarkupError(
				MARKUP_ERRORS.unknownAttribute,
				line,
				attribute.column,
				attribute.name,
				`<${tag}> has no attribute '${attribute.name}'`,
			);
		}
		if (seen.has(attribute.name)) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidAttribute,
				line,
				attribute.column,
				attribute.name,
				`<${tag}> sets '${attribute.name}' twice`,
			);
		}
		seen.add(attribute.name);
		const value = coerce(tag, attribute, spec, line);
		if (value !== undefined) {
			read[attribute.name] = value;
		}
	}

	for (const [name, spec] of Object.entries(table)) {
		if (spec.required && !Object.hasOwn(read, name)) {
			throw new MarkupError(MARKUP_ERRORS.invalidAttribute, line, column, name, `<${tag}> requires ${name}`);
		}
	}

	return read;
}

function coerce(tag: string, attribute: RawAttribute, spec: AttributeSpec, line: number): string | number | undefined {
	const refuse = (expected: string): MarkupError =>
		new MarkupError(
			MARKUP_ERRORS.invalidAttribute,
			line,
			attribute.column,
			attribute.name,
			`<${tag}> ${attribute.name}=${attribute.value} is not accepted; expected ${expected}`,
		);

	switch (spec.kind) {
		case "integer": {
			if (!INTEGER.test(attribute.value)) {
				throw refuse(`a whole number from ${spec.min} to ${spec.max}`);
			}
			const value = Number.parseInt(attribute.value, 10);
			if (value < spec.min || value > spec.max) {
				throw refuse(`a whole number from ${spec.min} to ${spec.max}`);
			}
			return value;
		}
		case "enum": {
			// Ignoring case, and returning the table's own spelling: the layout engine and the compiler
			// match one spelling, and an author should not have to know which.
			const wanted = attribute.value.toLowerCase();
			const match = spec.values.find((value) => value.toLowerCase() === wanted);
			if (match === undefined) {
				const listed = spec.values.slice(0, -1).join(", ");
				throw refuse(`${listed} or ${spec.values[spec.values.length - 1]}`);
			}
			return match;
		}
		case "text": {
			// Written empty means not given: a blank legend label or caption is never what was meant,
			// and the tag already has a meaning for the attribute being absent.
			if (attribute.value.length === 0) {
				return undefined;
			}
			if (attribute.value.length > spec.maxLength) {
				throw refuse(`at most ${spec.maxLength} characters`);
			}
			return attribute.value;
		}
		case "char": {
			// Code points, not UTF-16 units: an astral character is one character and two units, and
			// measuring units would refuse a legitimate single character as though it were two.
			if ([...attribute.value].length !== 1) {
				throw refuse("a single character");
			}
			return attribute.value;
		}
		default: {
			const exhaustive: never = spec;
			throw new Error(`unhandled attribute kind: ${JSON.stringify(exhaustive)}`);
		}
	}
}
