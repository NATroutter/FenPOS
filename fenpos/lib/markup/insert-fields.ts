import { type AppliesWhen, type AttributeSpec, conditionMet } from "@/lib/markup/attributes";
import { tagByName } from "@/lib/markup/tags";

/**
 * What controls a dialog needs to collect one tag's attributes.
 *
 * **Derived from the tag registry, never listed.** `TAGS` already says that `<chart>` takes a height
 * between 3 and 60, that `<barcode>` takes one of nine symbologies, and that `<text>`'s font names
 * something this install holds. A dialog restating any of that would be a second copy of the
 * language's own rules, kept in step by hand — which is the mistake the docs page and the parity
 * corpus both have tripwires against. Here the registry is read instead, so an attribute added to a
 * tag grows a control on its own and one removed takes its control with it.
 *
 * What the registry cannot say is left to the dialog: whether a tag encloses content, what to call
 * that content, and which of them want a picker rather than a box.
 */

/** One control, with everything needed to render and bound it. */
export type InsertControl = {
	name: string;
	label: string;
	required: boolean;
	/** What the attribute needs of another before it means anything. See {@link applies}. */
	appliesWhen?: AppliesWhen;
} & (
	| { kind: "select"; values: readonly string[] }
	| { kind: "number"; min: number; max: number }
	| { kind: "char" }
	/** A face: the printer's own, plus whatever fonts this install stores. */
	| { kind: "font"; maxLength: number }
	| { kind: "text"; maxLength: number }
);

/**
 * The controls one tag's attributes call for, in the order the registry declares them.
 *
 * Declaration order rather than alphabetical: a tag's table is written with its most important
 * attribute first — `<chart>`'s `type`, `<barcode>`'s — and that is the order someone filling the
 * dialog in wants to meet them in.
 *
 * @param tag a tag name as written in markup
 * @returns one control per attribute; empty for a tag that takes none, or a name no tag has
 */
export function fieldsFor(tag: string): InsertControl[] {
	const attributes = tagByName(tag)?.attributes;
	if (!attributes) {
		return [];
	}
	return Object.entries(attributes).map(([name, spec]) => controlFor(name, spec));
}

/**
 * Whether a control is worth showing beside the answers already given.
 *
 * The condition is the registry's, and the parser refuses what fails it — so a dialog that shows
 * every control regardless is a dialog whose own button writes markup the preview then rejects. A
 * control that stops applying is dropped rather than disabled, because a greyed-out box invites the
 * question of what would un-grey it, and the answer is a different value of a control still on
 * screen.
 *
 * A condition naming the enclosing tag's attribute is judged against the same values as one naming a
 * sibling: a dialog that collects a chart and its series holds both in one set of answers, so what a
 * series needs of its chart is a value already in hand. The parser has to wait for the chart to
 * close; here there is nothing to wait for.
 *
 * @param field one control
 * @param values every answer the dialog holds, by attribute name
 */
export function applies(field: InsertControl, values: Readonly<Record<string, string>>): boolean {
	return field.appliesWhen === undefined || conditionMet(field.appliesWhen, values);
}

/**
 * The control one attribute spec calls for.
 *
 * Exhaustive over the spec kinds by construction: the `never` in the default arm is what makes a new
 * kind added to `AttributeSpec` a compile error here rather than an attribute that silently renders
 * nothing.
 */
function controlFor(name: string, spec: AttributeSpec): InsertControl {
	// The attribute's own name, capitalised. No table of prettier labels, deliberately: what the
	// dialog writes into the document is `name=value`, so naming the field after the attribute is
	// what lets someone match the control they filled in to the markup that came out of it.
	const common = {
		name,
		label: `${name[0].toUpperCase()}${name.slice(1)}`,
		required: spec.required === true,
		...(spec.appliesWhen ? { appliesWhen: spec.appliesWhen } : {}),
	};

	switch (spec.kind) {
		case "enum":
			return { ...common, kind: "select", values: spec.values };
		case "integer":
			return { ...common, kind: "number", min: spec.min, max: spec.max };
		case "char":
			return { ...common, kind: "char" };
		case "text":
			return spec.names === "font"
				? { ...common, kind: "font", maxLength: spec.maxLength }
				: { ...common, kind: "text", maxLength: spec.maxLength };
		default: {
			const exhaustive: never = spec;
			throw new Error(`no control renders the attribute kind ${JSON.stringify(exhaustive)}`);
		}
	}
}
