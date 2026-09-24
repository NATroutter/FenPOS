import { MAX_NAME_LENGTH } from "@/lib/domain/naming";
import type { AttributeSpec } from "@/lib/markup/attributes";
import type { BlockTag } from "@/lib/markup/document";
import { type Span, scan } from "@/lib/markup/scan";
import { HOLDS_ONLY, PRINTER_DRAWN, REQUIRED_PARENT, TAGS, tagByName } from "@/lib/markup/tags";

/**
 * One thing the editor may offer, with an optional note shown beside it.
 *
 * `kind` says what part of a document the suggestion is, which is what lets the editor treat one
 * differently from another — an attribute's name is followed by its value, so accepting one writes
 * the `=` and asks again, where a tag's name and a value's text are complete as they stand.
 */
export interface Suggestion {
	label: string;
	detail?: string;
	kind: SuggestionKind;
}

/** What part of a document a {@link Suggestion} names. */
export type SuggestionKind = "tag" | "closing" | "attribute" | "value" | "variable";

/** Where the caret is, in terms the completion sources can answer from. */
export interface CaretContext {
	/** The names of the tags still open around the caret, outermost first. */
	open: string[];
	/** The tag whose header the caret is in, or null when it is not in one. */
	tag: string | null;
	inHeader: boolean;
	/** Whether that header opened with `</`, and so closes a tag rather than opening one. */
	closing: boolean;
	/** Whether nothing but the tag's own name stands between the caret and the header's `<`. */
	onTagName: boolean;
	/** The attribute the caret is on or in the value of, when it is in a header. */
	attribute: string | null;
	inValue: boolean;
	/** The word being typed, which a completion replaces. */
	word: { from: number; to: number };
}

/**
 * Reads what the caret is inside.
 *
 * Built from spans rather than from the strict tokenizer, because a caret is almost always inside a
 * construct that is still being typed, which the tokenizer refuses.
 *
 * @param source the document as typed
 * @param offset the caret's absolute position
 */
export function contextAt(source: string, offset: number): CaretContext {
	const spans = scan(source);
	const open: string[] = [];
	let tag: string | null = null;
	let inHeader = false;
	let closing = false;
	let onTagName = false;
	let attribute: string | null = null;
	let inValue = false;

	let headerTag: string | null = null;
	let headerClosing = false;
	let lastAttribute: string | null = null;

	for (const span of spans) {
		// Nothing written after the caret says anything about what the caret is inside. Reading on would
		// have the next tag in the document — the closing tag inserted with the opening one, or whatever
		// stands on the line below — clear the attribute whose value is being typed, which is every
		// document but one with nothing after the caret at all.
		if (span.from > offset) {
			break;
		}
		if (span.kind === "tag-name") {
			headerTag = source.slice(span.from, span.to).toLowerCase();
			headerClosing = span.closing === true;
			lastAttribute = null;
		}
		if (span.kind === "attribute-name") {
			lastAttribute = source.slice(span.from, span.to).toLowerCase();
		}
		if (span.kind === "tag-punctuation" && source[span.from] === ">") {
			// A header that ends at or after the caret says nothing about what encloses it. An opening
			// tag written below has not been reached, and a closing tag written below closes a block the
			// caret is inside rather than one it is past, so neither may move the stack.
			if (headerTag && span.to <= offset) {
				if (headerClosing) {
					const last = open.lastIndexOf(headerTag);
					if (last >= 0) {
						open.splice(last, 1);
					}
				} else if (tagByName(headerTag)?.kind === "PAIRED") {
					open.push(headerTag);
				}
			}
			headerTag = null;
		}
		if (span.kind === "attribute-value" && offset <= span.to) {
			inValue = true;
		}
	}

	// A header the caret sits in is one whose `<` is before it and whose `>` is not yet behind it.
	// Only the nearest `<` matters: if the first `>` after it comes at or past the caret, the caret is
	// still inside that header, and if it comes earlier the header closed before the caret was reached.
	const openTagStart = source.lastIndexOf("<", Math.max(0, offset - 1));
	if (openTagStart >= 0) {
		const closed = source.indexOf(">", openTagStart);
		if (closed < 0 || closed >= offset) {
			inHeader = true;
			const header = source.slice(openTagStart, offset);
			closing = header.startsWith("</");
			const name = /^<\/?([a-z0-9_-]*)/i.exec(header)?.[1] ?? "";
			tag = name.toLowerCase() || null;
			onTagName = /^<\/?[a-z0-9_-]*$/i.test(header);
			attribute = lastAttribute;
			inValue = /=[^\s>]*$/.test(header) || /="[^"]*$/.test(header);
		}
	}

	const wordStart = wordBoundary(source, offset);
	return { open, tag, inHeader, closing, onTagName, attribute, inValue, word: { from: wordStart, to: offset } };
}

/**
 * Where an entity being typed starts, when the caret is inside one.
 *
 * Only an unterminated run — `&`, `&l`, `&amp` — is one being typed. Once the `;` is there the entity
 * is written, and offering to replace it with itself helps nobody.
 *
 * @param source the document, or a single line of it: an entity holds no newline, so one line answers
 *        this exactly as the whole document would
 * @param offset the caret's position within that text
 * @returns where the entity starts, or null when the caret is not inside one
 */
export function entityAt(source: string, offset: number): number | null {
	const start = source.lastIndexOf("&", Math.max(0, offset - 1));
	if (start < 0) {
		return null;
	}
	return /^&[a-z]*$/i.test(source.slice(start, offset)) ? start : null;
}

/**
 * A `{name}` reference the caret is inside, and the text a completion would replace.
 *
 * `from` and `to` bound the name alone, braces excluded, and `to` runs to the end of the name the
 * caret stands in rather than stopping at the caret. That is what lets a name be *changed* rather
 * than only finished: with the caret in the middle of `{re|ceipt}`, replacing to the caret would
 * leave the tail behind and write `{phoneceipt}`.
 *
 * `terminated` says the `}` is already written, so accepting a name must not add a second one.
 */
export interface VariableReference {
	from: number;
	to: number;
	terminated: boolean;
}

/** The characters a variable's name is made of. Mirrors `NAME_PATTERN`, minus its first-character rule. */
const NAME_CHARACTERS = /^[a-z0-9_-]*$/i;

/**
 * Reads the `{name}` reference the caret is inside, when it is inside one.
 *
 * Deliberately not `variableReferenceAt`, which the parser and the scanner share: that one matches a
 * *finished* reference standing at a known position, and every reference is unfinished while it is
 * being typed. `{`, `{re`, `{re}` are all positions an author wants an answer at, and only the last
 * is a reference at all as far as the parser is concerned.
 *
 * What is between the brace and the caret has to be name-shaped, which is what keeps `Table {1 of`
 * from being read as a half-typed reference: the same rule that lets `Table {1 of 4}` print without
 * an escape. A newline or a closing brace in that run fails it too, so a `{` left further up the
 * document cannot claim a caret standing somewhere else entirely.
 *
 * @param source the document, or a single line of it: a reference is bounded by its own line
 * @param offset the caret's position within that text
 * @returns the reference, or null when the caret is not inside one
 */
export function variableAt(source: string, offset: number): VariableReference | null {
	const open = source.lastIndexOf("{", Math.max(0, offset - 1));
	if (open < 0 || !NAME_CHARACTERS.test(source.slice(open + 1, offset))) {
		return null;
	}

	// The name the caret stands in runs on past it, up to the brace that closes it.
	let to = offset;
	while (to < source.length && NAME_CHARACTERS.test(source[to])) {
		to += 1;
	}

	const from = open + 1;
	return to - from > MAX_NAME_LENGTH ? null : { from, to, terminated: source[to] === "}" };
}

/**
 * The variables this install defines, as an author sees them while typing a reference.
 *
 * What each one *currently resolves to* is deliberately left out, although the Insert dialog's
 * picker shows it. That figure is a live clock reading for a `DATETIME` and can be a paragraph for a
 * `STATIC`, so it belongs in a panel with room for it rather than in a one-line note beside a name
 * in a dropdown — and computing one per variable would put an evaluation on the page load of a tab
 * whose author may never type a brace.
 *
 * @param variables what the install holds
 * @returns one suggestion per variable, in the order they were given
 */
export function variableSuggestions(variables: readonly VariableName[]): Suggestion[] {
	return variables.map((variable) => ({
		label: variable.name,
		...(variable.detail === null ? {} : { detail: variable.detail }),
		kind: "variable" as const,
	}));
}

/**
 * Whether a caret here is somewhere the editor has anything at all to offer.
 *
 * The cheap question asked before the expensive one. A tag header stops at its line's own end, and
 * neither an entity nor a variable reference holds a newline, so a single line answers this exactly
 * as a pass over the whole document would — which is what lets a keystroke in ordinary text be
 * turned away before anything reads a document that may run to a million characters. The same
 * reasoning the linked rename and the tag matching already work by.
 *
 * It says where suggestions are *possible*, not what they are: inside a header with every attribute
 * already written, or inside a brace on an install that defines no variables, the real source still
 * answers with nothing.
 *
 * @param text one line of the document
 * @param at the caret's column within that line, 0-based
 * @returns true when the caret is inside a tag header, an entity, or a `{name}` being typed
 */
export function maySuggest(text: string, at: number): boolean {
	return contextAt(text, at).inHeader || entityAt(text, at) !== null || variableAt(text, at) !== null;
}

/** Where the word under the caret starts, so a completion replaces it rather than doubling it. */
function wordBoundary(source: string, offset: number): number {
	let at = offset;
	while (at > 0 && /[a-z0-9_-]/i.test(source[at - 1])) {
		at -= 1;
	}
	return at;
}

/**
 * The tags that may be written at the caret.
 *
 * A block that holds only named tags offers only those. Inside any block, the tags the printer draws
 * for itself are not offered: a region is a picture the server draws, and a symbol or a cut is not
 * something that can be drawn into one.
 */
export function tagSuggestions(context: CaretContext): Suggestion[] {
	const inside = context.open.length === 0 ? null : context.open[context.open.length - 1];
	const holds = inside === null ? undefined : HOLDS_ONLY.get(inside as BlockTag);
	if (holds) {
		return holds.map((name) => ({ label: name, detail: detailFor(name), kind: "tag" }));
	}
	return Object.keys(TAGS)
		.filter((name) => {
			if (inside !== null && PRINTER_DRAWN.has(name)) {
				return false;
			}
			const parent = REQUIRED_PARENT.get(name);
			return parent === undefined || parent === inside;
		})
		.map((name) => ({ label: name, detail: detailFor(name), kind: "tag" }));
}

/**
 * The one tag a `</` may name here: the innermost one still open.
 *
 * One, not the whole stack. Tags close in the order they opened, so `</box>` written while a
 * `<bold>` is still open is not a choice the author has — it is markup the parser refuses — and
 * offering it would be offering to write a refusal.
 *
 * Nothing when nothing is open, which is what a `</` typed in a document with no unclosed tag is:
 * a closing tag for nobody.
 */
export function closingSuggestions(context: CaretContext): Suggestion[] {
	const innermost = context.open.at(-1);
	return innermost === undefined ? [] : [{ label: innermost, detail: "the innermost open tag", kind: "closing" }];
}

/** A tag's attributes, minus the ones its header already carries. */
export function attributeSuggestions(context: CaretContext, source: string): Suggestion[] {
	const tag = context.tag === null ? undefined : tagByName(context.tag);
	if (!tag) {
		return [];
	}
	const written = new Set<string>();
	const start = source.lastIndexOf("<", Math.max(0, context.word.from - 1));
	for (const span of scan(source)) {
		if (span.kind === "attribute-name" && span.from > start && span.from < context.word.from) {
			written.add(source.slice(span.from, span.to).toLowerCase());
		}
	}
	return Object.entries(tag.attributes)
		.filter(([name]) => !written.has(name))
		.map(([name, spec]) => ({ label: name, detail: describe(spec), kind: "attribute" }));
}

/**
 * An enum's values, or a one-line description of what else the attribute accepts.
 *
 * Values are offered in lower case. `readAttributes` matches a fixed-set value ignoring case and
 * keeps the table's own spelling, so either case parses. Most of the registry spells its sets in
 * lower case and every example in the docs is written that way, but `Align` and `BarcodeSystem` hold
 * the upper-case spelling of the wire enum they are shared with — offering that spelling would write
 * `to=CENTER` into a document where everything else reads `to=center`.
 *
 * A text attribute that names something — `<text font=>` — is offered what it can name: the
 * printer's own two faces, which are fixed and need nobody to look them up, and whatever fonts this
 * install has stored, which only a caller can know. A caller that supplies none still gets the two,
 * because they are true of every install.
 *
 * @param context where the caret is
 * @param stored the names an install holds for each kind of named thing; omitted where a caller has
 *   none to hand, which costs only the stored half of the answer
 */
export function valueSuggestions(context: CaretContext, stored?: StoredNames): Suggestion[] {
	const tag = context.tag === null ? undefined : tagByName(context.tag);
	const spec = tag && context.attribute ? tag.attributes[context.attribute] : undefined;
	if (!spec) {
		return [];
	}
	if (spec.kind === "enum") {
		return spec.values.map((value) => ({ label: value.toLowerCase(), kind: "value" }));
	}
	if (spec.kind === "integer") {
		return [{ label: "", detail: describe(spec), kind: "value" }];
	}
	if (spec.kind === "text" && spec.names === "font") {
		return fontSuggestions(stored?.fonts ?? []);
	}
	return [];
}

/** One variable an install defines, as a completion shows it. */
export interface VariableName {
	name: string;
	/** Its description, or a word for its kind when it has none. Null leaves the name to stand alone. */
	detail: string | null;
}

/**
 * What an install holds, for the places markup names something this side cannot know by itself.
 *
 * Every field is optional, so a caller states what it has rather than what it does not. An absent
 * list costs exactly the suggestions that would have come from it and nothing else.
 */
export interface StoredNames {
	/** Fonts on the Assets tab, by the name markup refers to them by. */
	fonts?: readonly string[];
	/**
	 * Variables the Variables tab defines, by the name a `{reference}` writes.
	 *
	 * Absent where the install has switched variables off, because a brace is then ordinary text and
	 * offering a name would promise a substitution that will not happen. Absent too for the names a
	 * *request* supplies, which no editor can know: they arrive with the job and need no panel row.
	 */
	variables?: readonly VariableName[];
}

/**
 * The printer's built-in faces, which every install has.
 *
 * Offered in lower case for the reason the enums are: `readAttributes` keeps what was written and
 * the parser reads either case, and the docs write them lower.
 */
const BUILT_IN_FONTS: readonly [string, string][] = [
	["a", "the printer's own, drawn in its firmware"],
	["b", "the printer's own, narrower"],
];

/**
 * The faces a `font=` may name: the printer's two, then the install's own.
 *
 * A stored font is offered with what it costs written beside it, because the two kinds behave
 * differently and the difference matters before the line is written rather than after: a built-in
 * face is drawn by the printer and takes no `size`, while naming a stored one puts the whole line
 * on the raster path, where it is drawn here and sent as dots.
 *
 * A duplicate is dropped rather than shown twice. A stored font may legitimately be called `a` —
 * the asset namespace and the printer's faces are different namespaces and neither reserves the
 * other's names — and the parser resolves a built-in first, so offering it twice would offer a
 * choice the author does not have.
 */
function fontSuggestions(fonts: readonly string[]): Suggestion[] {
	const offered = new Set(BUILT_IN_FONTS.map(([name]) => name));
	const suggestions: Suggestion[] = BUILT_IN_FONTS.map(([label, detail]) => ({ label, detail, kind: "value" }));

	for (const name of fonts) {
		if (!offered.has(name)) {
			offered.add(name);
			suggestions.push({ label: name, detail: "stored, drawn here as dots", kind: "value" });
		}
	}
	return suggestions;
}

/**
 * Everything that may be written at the caret, or nothing when the caret is not in a header.
 *
 * A caret still on the name is offered tags, whatever the characters typed so far happen to spell. A
 * partial name resolving to a tag of its own — `<size` on the way to `<sizes`, were there such a tag —
 * is the name being typed rather than a header waiting for attributes, and offering an attribute there
 * would replace the name with it.
 *
 * A `</` is answered before any of that, and answered with one name rather than the registry: the
 * only tag that may be closed here is the one that is open. Past the name a closing tag has nothing
 * further to offer — it takes no attributes and the tokenizer refuses any — so `</size ` is offered
 * nothing rather than `<size>`'s width and height, which is what it used to get.
 */
export function suggestionsFor(context: CaretContext, source: string, stored?: StoredNames): Suggestion[] {
	if (!context.inHeader) {
		return [];
	}
	if (context.closing) {
		return context.onTagName ? closingSuggestions(context) : [];
	}
	if (context.inValue) {
		return valueSuggestions(context, stored);
	}
	if (context.onTagName || context.tag === null) {
		return tagSuggestions(context);
	}
	return attributeSuggestions(context, source);
}

/** What an attribute accepts, in the words a refusal would use. */
function describe(spec: AttributeSpec): string {
	switch (spec.kind) {
		case "integer":
			return `a whole number from ${spec.min} to ${spec.max}`;
		case "enum":
			return spec.values.map((value) => value.toLowerCase()).join(", ");
		case "text":
			return `text, at most ${spec.maxLength} characters`;
		case "char":
			return "one character";
	}
}

/** Whether a tag encloses anything, shown beside its name. */
function detailFor(name: string): string {
	return tagByName(name)?.kind === "VOID" ? "stands alone" : "encloses";
}

/**
 * The closing tag to insert for the tag ending at this offset, or null.
 *
 * Null for a void tag, which encloses nothing; for a name no tag registry knows; for a caret inside a
 * quoted value, where a `>` is a character rather than a terminator; and for a tag that already has
 * its closing tag, so that re-typing a `>` while editing does not insert a second one.
 */
export function closingFor(source: string, offset: number): string | null {
	const spans = scan(source);
	const terminator = spans.find(
		(span) => span.kind === "tag-punctuation" && span.to === offset && source[span.from] === ">",
	);
	if (!terminator) {
		return null;
	}
	const name = nameOfHeaderEndingAt(source, spans, terminator.from);
	if (name === null || name.closing) {
		return null;
	}
	const tag = tagByName(name.text);
	if (!tag || tag.kind === "VOID") {
		return null;
	}
	return hasClose(source, spans, name.text, terminator.to) ? null : `</${name.text}>`;
}

/**
 * The name span belonging to the header whose `>` sits at this offset.
 *
 * A name belongs to this header only if it was written after this header's own `<`, so a header with
 * no name of its own — `<>` — has none, rather than the name of whatever tag was written before it.
 */
function nameOfHeaderEndingAt(
	source: string,
	spans: Span[],
	terminatorStart: number,
): { text: string; closing: boolean; from: number; to: number } | null {
	let found: Span | null = null;
	for (const span of spans) {
		if (span.from >= terminatorStart) {
			break;
		}
		if (span.kind === "tag-punctuation" && source[span.from] === "<") {
			found = null;
		} else if (span.kind === "tag-name") {
			found = span;
		}
	}
	if (!found) {
		return null;
	}
	return {
		text: source.slice(found.from, found.to).toLowerCase(),
		closing: found.closing === true,
		from: found.from,
		to: found.to,
	};
}

/** Whether this tag already has a matching close after the given offset, counting nesting. */
function hasClose(source: string, spans: Span[], name: string, after: number): boolean {
	let depth = 0;
	for (const span of spans) {
		if (span.kind !== "tag-name" || span.from < after) {
			continue;
		}
		if (source.slice(span.from, span.to).toLowerCase() !== name) {
			continue;
		}
		if (span.closing) {
			if (depth === 0) {
				return true;
			}
			depth -= 1;
		} else {
			depth += 1;
		}
	}
	return false;
}

/**
 * Where the name sits in the header that holds this offset, or null when the offset is not in one.
 *
 * Read from one line, because a header is line-local: its `<`, its name, its attributes and its `>`
 * all stop where the line does. That is what lets a caret moving about a long document be answered
 * without reading the whole of it.
 *
 * The offset counts as inside a header from just after its `<` to just after its `>`, so a caret
 * resting at either end of a written tag still names it, while one sitting in the text before a `<`
 * does not. A header with no `>` yet — a tag halfway through being typed — runs to the line's end.
 *
 * @param text one line of the document
 * @param at the offset into that line, not into the document
 * @returns where the name begins and ends within the line, or null
 */
export function headerNameAt(text: string, at: number): { from: number; to: number } | null {
	let name: Span | null = null;
	let opened = -1;

	for (const span of scan(text)) {
		if (span.kind === "tag-name") {
			name = span;
			continue;
		}
		if (span.kind !== "tag-punctuation") {
			continue;
		}
		if (text[span.from] === "<") {
			opened = span.from;
			name = null;
		} else if (text[span.from] === ">") {
			if (name && at > opened && at <= span.to) {
				return { from: name.from, to: name.to };
			}
			opened = -1;
			name = null;
		}
	}

	return name && at > opened ? { from: name.from, to: name.to } : null;
}

/**
 * The name span of the tag that pairs with the one the caret is on, or null.
 *
 * Pairing is by nesting depth, so the inner tag of a nested pair renames with the inner close. Where
 * the document is unbalanced around the caret there is no honest answer, and nothing is returned
 * rather than a guess being rewritten.
 */
export function renamePairFor(source: string, offset: number): { from: number; to: number } | null {
	const spans = scan(source);
	const names = spans.filter((span) => span.kind === "tag-name");
	const index = names.findIndex((span) => span.from <= offset && offset <= span.to);
	if (index < 0) {
		return null;
	}
	const subject = names[index];
	const name = source.slice(subject.from, subject.to).toLowerCase();

	if (subject.closing) {
		let depth = 0;
		for (let at = index - 1; at >= 0; at--) {
			const span = names[at];
			if (source.slice(span.from, span.to).toLowerCase() !== name) {
				continue;
			}
			if (span.closing) {
				depth += 1;
			} else if (depth === 0) {
				return { from: span.from, to: span.to };
			} else {
				depth -= 1;
			}
		}
		return null;
	}

	let depth = 0;
	for (let at = index + 1; at < names.length; at++) {
		const span = names[at];
		if (source.slice(span.from, span.to).toLowerCase() !== name) {
			continue;
		}
		if (span.closing) {
			if (depth === 0) {
				return { from: span.from, to: span.to };
			}
			depth -= 1;
		} else {
			depth += 1;
		}
	}
	return null;
}

/** What a tag name is spelled with, as a whole inserted run. The empty run is one, being a deletion. */
const NAME_TEXT = /^[a-z0-9_-]*$/i;

/** One change to a document, located in the document as it stood before the change. */
export interface SourceEdit {
	from: number;
	to: number;
	insert: string;
}

/**
 * The partner rewrites a set of changes calls for, read from the document as it stood before them.
 *
 * Only name characters are carried across. A caret counts as being on a name at either of its ends, so
 * that a character appended to a name renames the partner too; the same position is where a name is
 * ended rather than extended, by the space that begins an attribute, by an `=`, or by the `>` that
 * terminates the header. Splicing one of those into the partner writes something the tokenizer refuses
 * — a closing tag takes its `>` directly after its name — so a run that is not a name renames nothing.
 *
 * A pair whose own name the changes already reach is left alone. Both halves are then being written by
 * hand, and a rewrite computed without sight of the other half would write the characters typed there
 * a second time. For the same reason a pair is rewritten at most once, however many carets are on it.
 */
export function renameEditsFor(before: string, changes: readonly SourceEdit[]): SourceEdit[] {
	const edits: SourceEdit[] = [];
	for (const change of changes) {
		if (!NAME_TEXT.test(change.insert)) {
			continue;
		}
		const pair = renamePairFor(before, change.from);
		if (pair === null) {
			continue;
		}
		if (changes.some((other) => other.from <= pair.to && other.to >= pair.from)) {
			continue;
		}
		if (edits.some((edit) => edit.from === pair.from && edit.to === pair.to)) {
			continue;
		}
		const subject = renamePairFor(before, pair.from);
		if (subject === null || change.from < subject.from || change.to > subject.to) {
			continue;
		}
		const renamed = `${before.slice(subject.from, change.from)}${change.insert}${before.slice(change.to, subject.to)}`;
		edits.push({ from: pair.from, to: pair.to, insert: renamed });
	}
	return edits;
}
