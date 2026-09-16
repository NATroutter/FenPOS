import { ENTITIES, isSpace, NAME_CHAR } from "@/lib/markup/tokenizer";
import { variableReferenceAt } from "@/lib/variables/definition";

/** What one span of source is, for an editor that has to colour it and read around it. */
export type SpanKind =
	| "tag-punctuation"
	| "tag-name"
	| "attribute-name"
	| "attribute-value"
	| "entity"
	| "variable"
	| "text";

/**
 * One run of source, located by absolute offset.
 *
 * `complete` is false while the construct is still being typed: an opening `<` with no `>` on its
 * line, or a quoted value with no closing quote. The strict tokenizer refuses both; an editor has to
 * colour them, because they are what every document looks like between two keystrokes.
 */
export interface Span {
	from: number;
	to: number;
	kind: SpanKind;
	complete: boolean;
	/** Set on a `tag-name` span: whether it named a closing tag. */
	closing?: boolean;
}

/**
 * Reads a document into spans, refusing nothing.
 *
 * The strict tokenizer is the parser of record and decides what a document means. This decides only
 * where things are, so that an editor can colour them and ask what the caret is inside. The two share
 * the character rules they scan with, so they cannot disagree about what a name or an entity is.
 *
 * @param source the document as typed
 * @returns the spans it found, in order and not overlapping; the space between a header's attributes
 *          and any stray character inside one are consumed without a span of their own
 */
export function scan(source: string): Span[] {
	const spans: Span[] = [];
	let index = 0;
	let textStart = 0;

	const flushText = (end: number): void => {
		if (end > textStart) {
			spans.push({ from: textStart, to: end, kind: "text", complete: true });
		}
	};

	while (index < source.length) {
		const character = source[index];

		if (character === "<") {
			flushText(index);
			index = readTag(source, index, spans);
			textStart = index;
			continue;
		}

		if (character === "&") {
			const entity = ENTITIES.find(([written]) => source.startsWith(written, index));
			if (entity) {
				flushText(index);
				spans.push({ from: index, to: index + entity[0].length, kind: "entity", complete: true });
				index += entity[0].length;
				textStart = index;
				continue;
			}
		}

		if (character === "{") {
			const match = variableReferenceAt(source, index);
			if (match) {
				flushText(index);
				spans.push({ from: index, to: index + match[0].length, kind: "variable", complete: true });
				index += match[0].length;
				textStart = index;
				continue;
			}
		}

		index += 1;
	}

	flushText(source.length);
	return spans;
}

/** Where this line ends, or the end of the source. */
function lineEnd(source: string, from: number): number {
	const end = source.indexOf("\n", from);
	return end < 0 ? source.length : end;
}

/**
 * Where this tag's own `>` is, or -1 when its line holds none.
 *
 * A `>` inside a quoted value belongs to the value: `<chart title="a > b">` ends at the last one,
 * not the first. A quote opens a value only directly after `=`, which is how the strict tokenizer
 * reads one, so a quote inside a bare value stays an ordinary character.
 */
function tagEnd(source: string, start: number, end: number): number {
	let at = start + 1;
	while (at < end) {
		if (source[at] === ">") {
			return at;
		}
		if (source[at] === "=" && source[at + 1] === '"') {
			const close = source.indexOf('"', at + 2);
			if (close < 0 || close >= end) {
				return -1;
			}
			at = close + 1;
			continue;
		}
		at += 1;
	}
	return -1;
}

/**
 * Reads one tag, complete or not, and returns where scanning continues.
 *
 * Mirrors the tokenizer's own tag scan: an optional `/`, a name of name characters, then attributes
 * written `key=value` with a value either quoted to its closing quote or bare up to a space or `>`.
 * Where the tokenizer would throw, this marks what it has as incomplete and stops at the line's end.
 */
function readTag(source: string, start: number, spans: Span[]): number {
	const end = lineEnd(source, start);
	const terminator = tagEnd(source, start, end);
	const complete = terminator >= 0;
	const limit = complete ? terminator : end;

	let at = start + 1;
	const closing = source[at] === "/";
	if (closing) {
		at += 1;
	}
	spans.push({ from: start, to: at, kind: "tag-punctuation", complete });

	const nameStart = at;
	while (at < limit && NAME_CHAR.test(source[at])) {
		at += 1;
	}
	if (at > nameStart) {
		spans.push({ from: nameStart, to: at, kind: "tag-name", complete, closing });
	}

	while (at < limit) {
		if (isSpace(source[at])) {
			at += 1;
			continue;
		}

		const keyStart = at;
		while (at < limit && NAME_CHAR.test(source[at])) {
			at += 1;
		}
		if (at > keyStart) {
			spans.push({ from: keyStart, to: at, kind: "attribute-name", complete });
		}

		if (at < limit && source[at] === "=") {
			spans.push({ from: at, to: at + 1, kind: "tag-punctuation", complete });
			at += 1;
			at = readValue(source, at, limit, end, complete, spans);
			continue;
		}

		if (at === keyStart) {
			// Nothing was consumed, so nothing here is a name or an `=`. Step past it rather than spin.
			at += 1;
		}
	}

	if (complete) {
		spans.push({ from: terminator, to: terminator + 1, kind: "tag-punctuation", complete: true });
		return terminator + 1;
	}
	return end;
}

/**
 * Reads one attribute value, quoted or bare, and returns where the header scan continues.
 *
 * A quoted value ends at its own closing quote, so it can be complete inside a tag that is not. A
 * bare value has no terminator of its own and runs until the tag ends, so it is complete exactly
 * when the tag is.
 */
function readValue(source: string, at: number, limit: number, end: number, complete: boolean, spans: Span[]): number {
	if (source[at] === '"') {
		const close = source.indexOf('"', at + 1);
		const closed = close >= 0 && close <= end;
		const valueEnd = closed ? close : end;
		spans.push({ from: at, to: at + 1, kind: "tag-punctuation", complete: closed });
		if (valueEnd > at + 1) {
			spans.push({ from: at + 1, to: valueEnd, kind: "attribute-value", complete: closed });
		}
		if (closed) {
			spans.push({ from: close, to: close + 1, kind: "tag-punctuation", complete: true });
			return close + 1;
		}
		return end;
	}

	const valueStart = at;
	while (at < limit && !isSpace(source[at]) && source[at] !== ">" && source[at] !== "\n") {
		at += 1;
	}
	if (at > valueStart) {
		spans.push({ from: valueStart, to: at, kind: "attribute-value", complete });
	}
	return at;
}
