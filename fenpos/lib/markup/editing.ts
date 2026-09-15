/**
 * What a toolbar button does to the text under the cursor.
 *
 * The editor is CodeMirror, so the component could reach for its transaction API directly. It does
 * not, because the interesting part is not the dispatch: it is where the caret lands afterwards, and
 * that is the part a person notices when it is wrong. Typing `<bold>` and being left outside the tag
 * means the next keystroke goes somewhere useless. Keeping the decision here makes it testable
 * without a DOM, which is the only kind of test this repo runs.
 */

import { type Tag, tagByName } from "@/lib/markup/tags";

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

/** Font names that pick one of the printer's two built-in fonts rather than a stored one. */
const BUILTIN_FONTS = new Set(["a", "b"]);

/**
 * Opening delimiter for a tag, with its argument if it takes one.
 *
 * `font` is the one tag whose opening carries a second thing besides its argument: a stored font is
 * meaningless at the printer's native size, so naming one here also writes a `size`. A built-in font
 * has no such attribute — `A` and `B` already are a size, chosen by the hardware — so it is excluded
 * by name rather than by the tag carrying no attributes, which `font` does have, for the stored case.
 */
function openingTag(tag: Tag, argument?: string): string {
	if (argument === undefined || argument === "") {
		return `<${tag.name}>`;
	}
	if (tag.name === "font" && !BUILTIN_FONTS.has(argument.toLowerCase())) {
		return `<${tag.name}=${argument} size=${DEFAULT_FONT_SIZE}>`;
	}
	return `<${tag.name}=${argument}>`;
}

/**
 * A box wraps whatever is selected rather than replacing it, the same as any other paired tag — but
 * on its own lines, because a box frames whole lines of a receipt and nobody writes one any other
 * way by hand. Selecting the lines to be framed and pressing the button is exactly what "wrap a
 * selection" already means elsewhere on the toolbar; only the line breaks are new.
 */
function boxEdit(selected: string): MarkupEdit {
	const before = "<box>\n";
	const insert = `${before}${selected}\n</box>`;
	return { insert, selectionFrom: before.length, selectionTo: before.length + selected.length };
}

/**
 * A table is a grid, not prose, so there is nothing in a selection worth carrying into it. This
 * always writes the same minimal skeleton instead — one row of two empty cells, ready to be filled
 * in and copied by hand for more — with the caret left inside the first cell, which is where typing
 * starts.
 */
function tableSkeleton(): MarkupEdit {
	const before = "<table>\n<row><cell>";
	const insert = `${before}</cell><cell></cell></row>\n</table>`;
	return { insert, selectionFrom: before.length, selectionTo: before.length };
}

/**
 * A chart needs series and labels to mean anything, and nobody has sample data memorised, so like a
 * table this ignores the selection and writes a skeleton: one named series of sample values and
 * matching labels, at a height that fits without measuring the paper first. The chart type is the
 * one thing no selection could ever supply, so it stays a parameter rather than part of the
 * skeleton's fixed text.
 *
 * @param type "bar", "line", "pie" or "scatter"
 */
function chartSkeleton(type: string): MarkupEdit {
	const before = `<chart=${type} height=8>\n<series=A>`;
	const values = "1,2,3";
	const insert = `${before}${values}</series>\n<labels>a,b,c</labels>\n</chart>`;
	return { insert, selectionFrom: before.length, selectionTo: before.length + values.length };
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
 * @param argument the tag's argument, for tags that take one
 * @returns the edit to apply, or undefined if no such tag exists
 */
export function markupEdit(name: string, selected: string, argument?: string): MarkupEdit | undefined {
	const tag = tagByName(name);
	if (!tag) {
		return undefined;
	}

	// Three tags whose content is a whole structure rather than something to style — see
	// {@link boxEdit}, {@link tableSkeleton} and {@link chartSkeleton} for why each departs from the
	// wrap-or-append rule below. A chart with no type is not a request this function can act on.
	if (tag.name === "box") {
		return boxEdit(selected);
	}
	if (tag.name === "table") {
		return tableSkeleton();
	}
	if (tag.name === "chart") {
		return argument ? chartSkeleton(argument) : undefined;
	}

	const open = openingTag(tag, argument);

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
