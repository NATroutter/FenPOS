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

/** Opening delimiter for a tag, with its argument if it takes one. */
function openingTag(tag: Tag, argument?: string): string {
	return argument === undefined || argument === "" ? `<${tag.name}>` : `<${tag.name}=${argument}>`;
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
