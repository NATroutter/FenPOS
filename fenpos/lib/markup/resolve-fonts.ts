import "server-only";
import { fontFace } from "@/lib/assets/asset-service";
import { ApiError } from "@/lib/errors";
import type { Node, ParseOptions } from "@/lib/markup/document";
import { MarkupError } from "@/lib/markup/errors";
import { parseDocument, type VariableContext } from "@/lib/markup/parser";
import type { FontFace } from "@/lib/raster/glyphs";

/**
 * The pre-pass that turns every configured `<font>` a request names into a face the compiler can
 * draw with.
 *
 * **The image pre-pass's twin, and it exists for the same reason.** A stored font is a database row
 * and parsing it walks the font's tables, while `compile` is a synchronous function of what it is
 * handed. So the loading happens here, once, before the compile starts, and the faces reach it
 * through `CompileSettings.fonts`.
 *
 * It also settles the one thing a caller must be told before a job exists: whether the names they
 * wrote are fonts this install has. `<font=B>` is a printer font and needs nothing; `<font=roboto>`
 * either names something stored or is a refusal, and a refusal that names the line and column is
 * worth far more than one that says a receipt failed to print.
 */

/** The faces one request may draw with, keyed by the name its markup writes. */
export type ResolvedFonts = ReadonlyMap<string, FontFace>;

/**
 * How a configured `<font>` opens, matched case-insensitively as the tag registry resolves it.
 *
 * A tag's body runs to the next `>` and its name to the first `=`, so a font that names anything at
 * all opens as exactly `<font=…>`. A receipt with no such text names no configured face, and is not
 * parsed: parsing is not free — a `<qr>` is encoded while it is measured — and most receipts use the
 * printer's own fonts and nothing else.
 */
const FONT_OPENING = /<font=/i;

/**
 * Loads every configured face a request refers to.
 *
 * A document that does not parse is skipped rather than reported, exactly as `resolveImages` skips
 * one: the compile that follows raises that failure with a line and a column, which is a better
 * answer than anything this pre-pass could give — and until then a receipt with a broken tag has
 * cost no database read.
 *
 * Parsed with `variables`, the same context the compile will use, because a `<font>` may sit inside
 * a scope that spans a substituted line and the tree this walks has to be the tree the compile
 * meets.
 *
 * @param data the receipt, exactly as the caller wrote it
 * @param variables the values `{name}` may resolve to, or null when variables are switched off
 * @param options the bounds to parse under, which are the install's own limits
 * @returns each configured name the document writes, mapped to its parsed face
 * @throws ApiError if a name is one no stored font answers to, carrying the line and column it was
 *         written at
 */
export async function resolveFonts(
	data: string,
	variables: VariableContext | null,
	options: Partial<ParseOptions>,
): Promise<ResolvedFonts> {
	const faces = new Map<string, FontFace>();
	if (!FONT_OPENING.test(data)) {
		return faces;
	}

	let nodes: Node[];
	try {
		nodes = parseDocument(data, variables, options).nodes;
	} catch (thrown) {
		if (thrown instanceof MarkupError) {
			return faces;
		}
		throw thrown;
	}

	// Loaded one after another rather than together. Each is a local read of a row this process
	// probably already holds parsed — `fontFace` is memoised by asset revision — so there is no wait
	// to overlap, and a receipt naming several faces is rarer than one naming several images.
	for (const [name, where] of collect(nodes)) {
		try {
			faces.set(name, await fontFace(name));
		} catch (thrown) {
			throw positioned(thrown, name, where);
		}
	}

	return faces;
}

/** Where a name was first written, for a refusal to point at. */
interface FontUse {
	line: number;
	column: number;
}

/**
 * Finds every configured face the tree names, and where each was first written.
 *
 * A built-in font leaves no mark to find: `<font=A>` patches `face` to null, so only a name this
 * install has to go and load shows up here at all.
 *
 * @param nodes the document's nodes
 * @returns each distinct name, mapped to the position of the tag that first wrote it
 */
function collect(nodes: Node[]): Map<string, FontUse> {
	const uses = new Map<string, FontUse>();

	const visit = (list: Node[]): void => {
		for (const node of list) {
			if (node.kind === "scope" && typeof node.patch.face === "string" && !uses.has(node.patch.face)) {
				uses.set(node.patch.face, { line: node.line, column: node.column });
			}
			if ("children" in node) {
				visit(node.children);
			}
		}
	};
	visit(nodes);

	return uses;
}

/**
 * Adds the position and the name to a refusal.
 *
 * The same thing `resolveImages` does for a reference it cannot resolve, and for the same reason:
 * "there is no font called 'roboto'" is a different message from "line 4, column 1 has no font called
 * 'roboto'" to whoever has to fix the receipt.
 *
 * @param thrown whatever the load raised
 * @param name the name that was asked for
 * @param where the tag that first wrote it
 * @returns the error to throw
 */
function positioned(thrown: unknown, name: string, where: FontUse): unknown {
	if (!(thrown instanceof ApiError)) {
		return thrown;
	}
	return new ApiError(
		thrown.code,
		thrown.message,
		{ ...thrown.details, line: where.line, column: where.column, detail: name },
		{ cause: thrown },
	);
}
