import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";

/** What one attribute accepts, and whether the tag can do without it. */
export type AttributeSpec = (
	| { kind: "integer"; min: number; max: number }
	| { kind: "enum"; values: readonly string[] }
	| { kind: "text"; maxLength: number; names?: NameSource }
	| { kind: "char" }
) & {
	/** The tag means nothing without this attribute, so leaving it off is refused. */
	required?: true;
	/** The attribute means nothing unless something else holds a particular value. */
	appliesWhen?: AppliesWhen;
};

/**
 * When an attribute is only meaningful beside a particular value of another.
 *
 * What a tag *has* and which combinations of it *mean* anything are different questions, and the
 * second used to be answered only inside the parser, a hand-written check per case. Nothing that
 * offers the attributes could see those checks, so the panel's own Insert dialog wrote `area` onto a
 * bar chart and a `size` onto the printer's own font: markup refused the moment it was compiled, by
 * the button that had just written it. Declared here, one condition is read both by the parser that
 * refuses the combination and by the editor that would otherwise offer it.
 *
 * `is` and `isNot` are two ways of saying the same thing, and which one fits depends on what is being
 * depended upon: a fixed set has few enough values to name the ones that qualify, while a font name
 * is free text whose qualifying values cannot be listed at all — only the two that disqualify it.
 */
export interface AppliesWhen {
	/** The attribute depended on: this tag's own, or the enclosing tag's. */
	attribute: string;
	/** Values of it that make this attribute mean something. Matched ignoring case. */
	is?: readonly string[];
	/** Values that make it mean nothing, for a dependency whose qualifying values cannot be listed. */
	isNot?: readonly string[];
	/** Whose attribute {@link attribute} names. The tag's own unless said otherwise. */
	on?: "self" | "parent";
	/**
	 * The refusal's words after `<tag> name`.
	 *
	 * Prose rather than a generated sentence, because a rule explained is a rule an author can act on:
	 * "applies to a line chart only" says what to do about it where "requires type=line" only restates
	 * the condition.
	 */
	because: string;
}

/**
 * Where the names a text attribute is usually given come from.
 *
 * Free text to the parser — anything up to `maxLength` is accepted, and what a name refers to is
 * resolved long after this — but not free text to an author, who is naming something that either
 * exists or does not. Declared here so that an editor can offer what exists without a table of its
 * own listing which attributes happen to name what, which is the kind of second list that goes
 * stale the day a tag is added.
 */
export type NameSource = "font";

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

	requireApplicable(tag, raw, table, read, line, column);

	return read;
}

/**
 * Refuses an attribute written beside a value that leaves it meaningless.
 *
 * Only the conditions this tag can settle on its own. One naming the enclosing tag's attribute is
 * left alone here: what a tag is written inside is not known while its own opening tag is being
 * read, so the tree checks those once it has somewhere to put it.
 *
 * @throws MarkupError if an attribute's condition is not met by what was written beside it
 */
function requireApplicable(
	tag: string,
	raw: readonly RawAttribute[],
	table: AttributeTable,
	read: Attributes,
	line: number,
	column: number,
): void {
	for (const [name, spec] of Object.entries(table)) {
		const condition = spec.appliesWhen;
		if (!condition || condition.on === "parent" || !Object.hasOwn(read, name) || conditionMet(condition, read)) {
			continue;
		}
		throw new MarkupError(
			MARKUP_ERRORS.invalidAttribute,
			line,
			raw.find((attribute) => attribute.name === name)?.column ?? column,
			name,
			`<${tag}> ${name} ${condition.because}`,
		);
	}
}

/**
 * Whether a condition is met by the attributes it is judged against.
 *
 * Case-insensitively, and against the value as written: an enum has already been read back in the
 * registry's own spelling by the time this runs, but a font name has not, and `A` names the same
 * built-in face as `a`.
 *
 * An attribute that was left off counts as empty rather than as absent, which is what makes a
 * dependency on a required attribute safe to state: `is` cannot be satisfied by nothing, and `isNot`
 * is not contradicted by it.
 *
 * @param condition what the attribute depends on
 * @param values the attributes it is judged beside — the tag's own, or its parent's
 */
export function conditionMet(condition: AppliesWhen, values: Attributes): boolean {
	const held = String(values[condition.attribute] ?? "").toLowerCase();
	const matches = (value: string): boolean => value.toLowerCase() === held;
	return (condition.is?.some(matches) ?? true) && !(condition.isNot?.some(matches) ?? false);
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
