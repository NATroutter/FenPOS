import { DEFAULT_PARSE_OPTIONS, type Document, type ParseOptions, type VariableContext } from "@/lib/markup/document";
import { flattenLine, splitLines } from "@/lib/markup/flatten";
import type { Line } from "@/lib/markup/model";
import { tokenize } from "@/lib/markup/tokenizer";
import { buildDocument } from "@/lib/markup/tree";

/**
 * Turns a `data` document into a tree, and one line of it into the render model.
 *
 * **Parsing is the boundary that makes the rest of the system safe.** Markup is the only way a
 * caller can influence printer state, and every byte the printer would read as a command either
 * comes from a recognised tag or is rejected before a node exists. A raw control character is never
 * passed through — the tokenizer refuses one as it scans, and refuses one arriving inside a
 * variable's value too — so a request cannot desynchronise the device.
 *
 * Three stages, each with one job. The tokenizer reads characters: it substitutes variables,
 * decodes entities and numbers lines and columns. The tree builder reads tokens: it checks every
 * shape rule the language has, once, so nothing downstream asks again and nothing downstream can
 * answer differently. The flattener reads the tree: it resolves each node's style and measures the
 * symbols. This module is the order they run in and nothing else.
 *
 * Any refusal is a `MarkupError` carrying the line and column it points at, which is the property
 * that makes a `400` from this API worth reading.
 */

/**
 * The variable values one compile may substitute.
 *
 * Defined with the document model, because the tokenizer is what substitutes them and every caller
 * that supplies them goes through it. Re-exported here so callers that ask this module for the type
 * still get it.
 */
export type { VariableContext };

/** Windows line endings become plain newlines before anything is counted or numbered. */
export function normaliseSource(source: string): string {
	return source.replace(/\r\n/g, "\n");
}

/**
 * Parses a whole document.
 *
 * @param source the document text, as supplied by the client
 * @param variables the values `{name}` references may resolve to, or null to read braces as
 *        ordinary text — which is what `variables.enabled: false` means, and what every caller
 *        meant before variables existed
 * @param options the limits to parse under, defaulting to {@link DEFAULT_PARSE_OPTIONS}
 * @returns the document's tree and its source lines
 * @throws MarkupError if the document is malformed, carrying the line and column at fault
 */
export function parseDocument(
	source: string | null | undefined,
	variables?: VariableContext | null,
	options?: Partial<ParseOptions>,
): Document {
	return buildDocument(tokenize(normaliseSource(source ?? ""), variables ?? null), {
		...DEFAULT_PARSE_OPTIONS,
		...options,
	});
}

/**
 * Parses one line and flattens it to the render model.
 *
 * Identical single-line markup must produce an identical `Line`, which is what the parser's tests
 * exist to prove. Also what the image pre-pass uses to screen a line. Not for documents: a caller
 * holding several lines wants {@link parseDocument}, because only that knows which line each
 * refusal belongs to.
 *
 * @param source one line of markup
 * @param variables the values `{name}` references may resolve to, or null for none
 * @returns the parsed line; a blank source yields a line with no spans
 * @throws MarkupError if the line is malformed, carrying the column at fault
 */
export function parseLine(source: string | null | undefined, variables?: VariableContext | null): Line {
	const text = source ?? "";
	if (text.includes("\n") || text.includes("\r")) {
		throw new Error("parseLine takes one line; use parseDocument for a document");
	}
	const [line] = splitLines(parseDocument(text, variables).nodes);
	return flattenLine(line.nodes);
}
