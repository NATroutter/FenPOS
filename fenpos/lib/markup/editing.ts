/**
 * What a toolbar button does to the text under the cursor.
 *
 * The editor is CodeMirror, so the component could reach for its transaction API directly. It does
 * not, because the interesting part is not the dispatch: it is where the caret lands afterwards, and
 * that is the part a person notices when it is wrong. Typing `<bold>` and being left outside the tag
 * means the next keystroke goes somewhere useless. Keeping the decision here makes it testable
 * without a DOM, which is the only kind of test this repo runs.
 */

import { TAGS, type Tag, tagByName } from "@/lib/markup/tags";

/** A replacement for the current selection, and where to leave the selection afterwards. */
export interface MarkupEdit {
	/** Text to put in place of what was selected. */
	insert: string;
	/** Start of the new selection, as an offset into {@link insert}. */
	selectionFrom: number;
	/** End of the new selection. Equal to {@link selectionFrom} for a bare caret. */
	selectionTo: number;
}

/** The size, in dots, a stored font is written at when the toolbar does not ask for another. */
const DEFAULT_FONT_SIZE = 24;

/** Printed lines a chart's skeleton stands, when the caller names no height of its own. */
const DEFAULT_CHART_HEIGHT = 8;

/** Font names that pick one of the printer's two built-in fonts rather than a stored one. */
const BUILTIN_FONTS = new Set(["a", "b"]);

/** An `&` that the tokenizer would read as the start of an entity. */
const ENTITY_START = /&(?=lt;|amp;|lbrace;|quot;)/g;

/**
 * Writes a value so the tokenizer reads back exactly this string.
 *
 * Only what would change the reading is escaped: an `&` that begins an entity, and every `"`. A value
 * holding a space or a `>` is quoted, because written bare it would end at that character.
 */
function attributeValue(value: string): string {
	const escaped = value.replace(ENTITY_START, "&amp;").replace(/"/g, "&quot;");
	return /[ >]/.test(escaped) ? `"${escaped}"` : escaped;
}

/**
 * Writes text as content, so the tokenizer reads back the characters that were typed.
 *
 * Three of them mean something where they stand: a `<` opens a tag, an `&` that begins an entity
 * opens that entity, and a `{` opens a variable reference wherever this install has variables switched
 * on. A cell holding `<b` or a series called `R&D` is ordinary text to the person typing it and a
 * parse error to everyone else, so it is escaped on the way in rather than explained afterwards.
 */
function contentText(text: string): string {
	return text.replace(ENTITY_START, "&amp;").replace(/</g, "&lt;").replace(/\{/g, "&lbrace;");
}

/**
 * Opening delimiter for a tag, with its attributes.
 *
 * `text` is the one tag whose opening carries something the caller did not say: a stored font is
 * meaningless at the printer's native size, so naming one here also writes a `size`. A built-in font
 * has no such attribute — `A` and `B` already are a size, chosen by the hardware — so it is excluded
 * by name.
 */
function openingTag(tag: Tag, attributes: Readonly<Record<string, string>> = {}): string {
	const written: Record<string, string> = { ...attributes };
	if (tag.name === "text" && written.font && !BUILTIN_FONTS.has(written.font.toLowerCase()) && !written.size) {
		written.size = String(DEFAULT_FONT_SIZE);
	}
	const pairs = Object.entries(written)
		.filter(([, value]) => value !== "")
		.map(([key, value]) => ` ${key}=${attributeValue(value)}`)
		.join("");
	return `<${tag.name}${pairs}>`;
}

/** One series as a dialog collected it: the values it plots, and the attributes it was given. */
export interface SeriesDraft {
	/** What it plots, as written: numbers, or `x:y` pairs where the chart is a scatter. */
	values: string;
	/**
	 * Its attributes, by the name markup writes them under.
	 *
	 * A record rather than a field per attribute, for the reason the dialog holds the enclosing tag's
	 * attributes in one: `<series>` declares `name`, `pattern` and `marker` in the registry, and a
	 * fourth added there should reach the document without this interface having heard of it.
	 */
	attributes: Readonly<Record<string, string>>;
}

/**
 * The structure a dialog filled in, for the two tags whose content is one.
 *
 * Separate from the attributes rather than squeezed in beside them: a chart's series and a table's
 * cells are rows of text that the markup nests, and a flat record of strings has nowhere to put the
 * second one. Optional throughout, because the same two tags are still written without a dialog —
 * from a keyboard shortcut, or by a caller that has nothing to fill in — and a skeleton is what those
 * get.
 */
export type InsertData =
	| { kind: "chart"; series: readonly SeriesDraft[]; labels: string }
	| { kind: "table"; rows: readonly (readonly string[])[] };

/**
 * A box wraps whatever is selected rather than replacing it, the same as any other paired tag — but
 * on its own lines, because a box frames whole lines of a receipt and nobody writes one any other
 * way by hand. Selecting the lines to be framed and pressing the button is exactly what "wrap a
 * selection" already means elsewhere on the toolbar; only the line breaks are new. The selection is
 * written exactly as it was, with none of its lines indented: a line that starts with text prints
 * its indentation, so adding any here would print inside the box.
 */
function boxEdit(tag: Tag, selected: string, attributes: Readonly<Record<string, string>>): MarkupEdit {
	const before = `${openingTag(tag, attributes)}\n`;
	const insert = `${before}${selected}\n</box>`;
	return { insert, selectionFrom: before.length, selectionTo: before.length + selected.length };
}

/**
 * A table is a grid, not prose, so there is nothing in a selection worth carrying into it. This
 * always writes the same minimal skeleton instead — one row of two empty cells, ready to be filled
 * in and copied by hand for more — with the caret left inside the first cell, which is where typing
 * starts.
 *
 * One tag to a line, indented a step per level, the way the docs' examples are written. A row of
 * cells run together on one line fits while there are two of them and stops fitting at the fifth,
 * which is the point at which somebody has to reformat a table by hand — so the skeleton is written
 * from the start in the shape it will have to end up in.
 */
function tableSkeleton(tag: Tag, attributes: Readonly<Record<string, string>>): MarkupEdit {
	const before = `${openingTag(tag, attributes)}\n  <row>\n    <cell>`;
	const insert = `${before}</cell>\n    <cell></cell>\n  </row>\n</table>`;
	return { insert, selectionFrom: before.length, selectionTo: before.length };
}

/**
 * A table whose grid is already filled in, which is what a dialog that asked for the cells has.
 *
 * The caret is left after the whole table rather than in its first cell, unlike {@link tableSkeleton}:
 * a skeleton is somewhere to start typing, and a grid that has been typed already is somewhere to
 * type *past*.
 *
 * @param tag the `table` tag itself, for the attribute rules every opening tag obeys
 * @param attributes what the caller collected
 * @param rows the cells, a row at a time; a row is written even where every cell in it is empty,
 *   since the grid's shape is what was asked for
 */
function tableEdit(
	tag: Tag,
	attributes: Readonly<Record<string, string>>,
	rows: readonly (readonly string[])[],
): MarkupEdit {
	const lines = [openingTag(tag, attributes)];
	for (const row of rows) {
		lines.push("  <row>");
		for (const cell of row) {
			lines.push(`    <cell>${contentText(cell.trim())}</cell>`);
		}
		lines.push("  </row>");
	}
	lines.push("</table>");

	const insert = lines.join("\n");
	return { insert, selectionFrom: insert.length, selectionTo: insert.length };
}

/**
 * A chart needs series and labels to mean anything, and nobody has sample data memorised, so like a
 * table this ignores the selection and writes a skeleton: one named series of sample values and
 * matching labels, ready to be replaced.
 *
 * **Every attribute the caller gives is written, not only the type.** The opening tag is built by
 * {@link openingTag} like any other tag's, so a `title`, a `width` or a `legend` reaches the document
 * instead of being dropped — which is what happened while this wrote its own opening tag out of the
 * type alone, and what made the Insert dialog's new chart controls worth nothing. A height is
 * supplied only when the caller named none: a chart cannot sensibly default to no height, and eight
 * lines is a first draft someone can see before they measure it against the paper.
 *
 * A scatter is the exception twice over: it plots pairs rather than a run of values, and it names
 * nothing, so it takes `x:y` samples and no `<labels>` at all. A skeleton that a press of the button
 * turns straight into a refusal is worse than no button.
 *
 * Indented the way the docs' examples are, since the series and labels are nested inside the chart.
 *
 * @param tag the `chart` tag itself, for the attribute rules every opening tag obeys
 * @param attributes what the caller collected; `type` is required and the rest are the author's
 */
function chartSkeleton(tag: Tag, attributes: Readonly<Record<string, string>>): MarkupEdit {
	// Spread first so the caller's own order stands, and the default height falls at the end rather
	// than pushing itself in front of the type.
	const written = { ...attributes, height: attributes.height ?? String(DEFAULT_CHART_HEIGHT) };
	const before = `${openingTag(tag, written)}\n  <series name=A>`;
	const scatter = (attributes.type ?? "").toLowerCase() === "scatter";
	const values = scatter ? "1:2,2:3,3:5" : "1,2,3";
	const labels = scatter ? "" : "\n  <labels>a,b,c</labels>";
	const insert = `${before}${values}</series>${labels}\n</chart>`;
	return { insert, selectionFrom: before.length, selectionTo: before.length + values.length };
}

/**
 * A chart whose series were filled in, rather than the sample one a skeleton leaves to be replaced.
 *
 * A series with no values is dropped: the dialog collects several at once, and an empty row is one
 * somebody added and thought better of rather than a series of nothing — which the parser would
 * refuse anyway. `<labels>` is written only when there are labels, since an empty one names no
 * category and a scatter refuses labels outright.
 *
 * The caret lands after the chart, for the reason it lands after a filled-in table: there is nothing
 * left in here to replace.
 *
 * @param tag the `chart` tag itself, for the attribute rules every opening tag obeys
 * @param attributes what the caller collected; `type` is required and the rest are the author's
 * @param data the series and the labels row
 */
function chartEdit(
	tag: Tag,
	attributes: Readonly<Record<string, string>>,
	data: Extract<InsertData, { kind: "chart" }>,
): MarkupEdit {
	const written = { ...attributes, height: attributes.height ?? String(DEFAULT_CHART_HEIGHT) };
	const lines = [openingTag(tag, written)];

	for (const series of data.series) {
		const values = series.values.trim();
		if (values === "") {
			continue;
		}
		lines.push(`  ${openingTag(TAGS.series, series.attributes)}${contentText(values)}</series>`);
	}

	const labels = data.labels.trim();
	if (labels !== "") {
		lines.push(`  <labels>${contentText(labels)}</labels>`);
	}
	lines.push("</chart>");

	const insert = lines.join("\n");
	return { insert, selectionFrom: insert.length, selectionTo: insert.length };
}

/**
 * Works out the edit a toolbar button should make.
 *
 * Three cases, and the difference between them is the whole point of the function:
 *
 * - A paired tag over a selection wraps it and keeps that text selected, so the styling can be seen
 *   applied to the words it was applied to, and a second button press styles the same words again.
 * - A paired tag with nothing selected writes the pair and puts the caret between the halves, which
 *   is where the text that is about to be typed belongs.
 * - A void tag prints nothing and encloses nothing, so it is appended after whatever was selected
 *   rather than replacing it. Replacing would silently delete the selection, and a button that
 *   deletes text while claiming to add a rule is the worst thing on this toolbar.
 *
 * @param name a tag name as written in markup
 * @param selected the text currently selected, empty for a bare caret
 * @param attributes the attributes to write into the opening tag, for tags that take them
 * @param data the structure a dialog filled in, for the two tags that enclose one; without it those
 *   two write a skeleton to be filled in by hand
 * @returns the edit to apply, or undefined if no such tag exists
 */
export function markupEdit(
	name: string,
	selected: string,
	attributes?: Readonly<Record<string, string>>,
	data?: InsertData,
): MarkupEdit | undefined {
	const tag = tagByName(name);
	if (!tag) {
		return undefined;
	}

	// Three tags whose content is a whole structure rather than something to style — see
	// {@link boxEdit}, {@link tableSkeleton} and {@link chartSkeleton} for why each departs from the
	// wrap-or-append rule below. A chart with no type is not a request this function can act on.
	const written = attributes ?? {};
	if (tag.name === "box") {
		return boxEdit(tag, selected, written);
	}
	if (tag.name === "table") {
		return data?.kind === "table" ? tableEdit(tag, written, data.rows) : tableSkeleton(tag, written);
	}
	if (tag.name === "chart") {
		if (!attributes?.type) {
			return undefined;
		}
		return data?.kind === "chart" ? chartEdit(tag, attributes, data) : chartSkeleton(tag, attributes);
	}

	const open = openingTag(tag, attributes);

	if (tag.kind === "VOID") {
		// After the selection, not over it. The caret sits past the tag so typing continues on the
		// far side of it rather than inside a tag that has no inside.
		const insert = selected + open;
		return { insert, selectionFrom: insert.length, selectionTo: insert.length };
	}

	const close = `</${tag.name}>`;
	return {
		insert: open + selected + close,
		selectionFrom: open.length,
		selectionTo: open.length + selected.length,
	};
}

/**
 * Works out the edit for inserting a variable reference.
 *
 * `{name}` is not a tag — `tagByName` knows nothing about it, because it belongs to a different
 * addressing scheme with its own delimiters, and adding it to {@link TAGS} would misdescribe it as
 * one. It behaves like a void tag once written, though: it stands alone, encloses nothing, and there
 * is nothing to see it applied to, so this follows {@link markupEdit}'s own rule for a void tag —
 * appended after whatever was selected, caret left past it — rather than inventing a second one.
 *
 * @param name the variable's name, exactly as stored
 * @param selected the text currently selected, empty for a bare caret
 * @returns the edit to apply
 */
export function variableEdit(name: string, selected: string): MarkupEdit {
	const insert = `${selected}{${name}}`;
	return { insert, selectionFrom: insert.length, selectionTo: insert.length };
}
