import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";

/** What one attribute accepts. */
export type AttributeSpec =
	| { kind: "integer"; min: number; max: number }
	| { kind: "enum"; values: readonly string[] }
	| { kind: "text"; maxLength: number };

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
 * Every refusal names the attribute and points at its own column, because a tag can carry
 * several and "invalid attribute on line 3" would send the author counting.
 */
export function readAttributes(
	tag: string,
	raw: readonly RawAttribute[],
	table: AttributeTable,
	line: number,
): Attributes {
	const read: Record<string, string | number> = {};

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
		if (Object.hasOwn(read, attribute.name)) {
			throw new MarkupError(
				MARKUP_ERRORS.invalidAttribute,
				line,
				attribute.column,
				attribute.name,
				`<${tag}> sets '${attribute.name}' twice`,
			);
		}
		read[attribute.name] = coerce(tag, attribute, spec, line);
	}

	return read;
}

function coerce(tag: string, attribute: RawAttribute, spec: AttributeSpec, line: number): string | number {
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
			if (!spec.values.includes(attribute.value)) {
				const listed = spec.values.slice(0, -1).join(", ");
				throw refuse(`${listed} or ${spec.values[spec.values.length - 1]}`);
			}
			return attribute.value;
		}
		case "text": {
			if (attribute.value.length > spec.maxLength) {
				throw refuse(`at most ${spec.maxLength} characters`);
			}
			return attribute.value;
		}
		default: {
			const exhaustive: never = spec;
			throw new Error(`unhandled attribute kind: ${JSON.stringify(exhaustive)}`);
		}
	}
}
