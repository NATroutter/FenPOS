import type { AttributeSpec } from "@/lib/markup/attributes";
import type { BlockTag } from "@/lib/markup/document";
import { type Span, scan } from "@/lib/markup/scan";
import { HOLDS_ONLY, PRINTER_DRAWN, REQUIRED_PARENT, TAGS, tagByName } from "@/lib/markup/tags";

/** One thing the editor may offer, with an optional note shown beside it. */
export interface Suggestion {
	label: string;
	detail?: string;
}

/** Where the caret is, in terms the completion sources can answer from. */
export interface CaretContext {
	/** The names of the tags still open around the caret, outermost first. */
	open: string[];
	/** The tag whose header the caret is in, or null when it is not in one. */
	tag: string | null;
	inHeader: boolean;
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
	let onTagName = false;
	let attribute: string | null = null;
	let inValue = false;

	let headerTag: string | null = null;
	let headerClosing = false;
	let lastAttribute: string | null = null;

	for (const span of spans) {
		if (span.kind === "tag-name") {
			headerTag = source.slice(span.from, span.to).toLowerCase();
			headerClosing = span.closing === true;
			lastAttribute = null;
		}
		if (span.kind === "attribute-name" && span.from <= offset) {
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
		if (span.kind === "attribute-value" && span.from <= offset && offset <= span.to) {
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
			const name = /^<\/?([a-z0-9_-]*)/i.exec(header)?.[1] ?? "";
			tag = name.toLowerCase() || null;
			onTagName = /^<\/?[a-z0-9_-]*$/i.test(header);
			attribute = lastAttribute;
			inValue = /=[^\s>]*$/.test(header) || /="[^"]*$/.test(header);
		}
	}

	const wordStart = wordBoundary(source, offset);
	return { open, tag, inHeader, onTagName, attribute, inValue, word: { from: wordStart, to: offset } };
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
		return holds.map((name) => ({ label: name, detail: detailFor(name) }));
	}
	return Object.keys(TAGS)
		.filter((name) => {
			if (inside !== null && PRINTER_DRAWN.has(name)) {
				return false;
			}
			const parent = REQUIRED_PARENT.get(name);
			return parent === undefined || parent === inside;
		})
		.map((name) => ({ label: name, detail: detailFor(name) }));
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
		.map(([name, spec]) => ({ label: name, detail: describe(spec) }));
}

/**
 * An enum's values, or a one-line description of what else the attribute accepts.
 *
 * Values are offered in lower case. `readAttributes` matches a fixed-set value ignoring case and
 * keeps the table's own spelling, so either case parses. Most of the registry spells its sets in
 * lower case and every example in the docs is written that way, but `Align` and `BarcodeSystem` hold
 * the upper-case spelling of the wire enum they are shared with — offering that spelling would write
 * `to=CENTER` into a document where everything else reads `to=center`.
 */
export function valueSuggestions(context: CaretContext): Suggestion[] {
	const tag = context.tag === null ? undefined : tagByName(context.tag);
	const spec = tag && context.attribute ? tag.attributes[context.attribute] : undefined;
	if (!spec) {
		return [];
	}
	if (spec.kind === "enum") {
		return spec.values.map((value) => ({ label: value.toLowerCase() }));
	}
	if (spec.kind === "integer") {
		return [{ label: "", detail: describe(spec) }];
	}
	return [];
}

/**
 * Everything that may be written at the caret, or nothing when the caret is not in a header.
 *
 * A caret still on the name is offered tags, whatever the characters typed so far happen to spell. A
 * partial name resolving to a tag of its own — `<size` on the way to `<sizes`, were there such a tag —
 * is the name being typed rather than a header waiting for attributes, and offering an attribute there
 * would replace the name with it.
 */
export function suggestionsFor(context: CaretContext, source: string): Suggestion[] {
	if (!context.inHeader) {
		return [];
	}
	if (context.inValue) {
		return valueSuggestions(context);
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
