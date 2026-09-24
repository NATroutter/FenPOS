import { describe, expect, it } from "vitest";
import { diagnosticsFor, MAX_MARKED_CHARS, type PositionedError } from "@/lib/markup/diagnostics";

/**
 * What the editor underlines when a preview comes back with something wrong.
 *
 * The compiler already says which line and which character failed; until this existed that was a
 * sentence in the other pane and the author went counting. Every case here is about turning those
 * two numbers into a range that lands on the thing at fault.
 */

const error = (line: number | null, column: number | null, message = "Something is wrong"): PositionedError => ({
	line,
	column,
	message,
});

/** The text each diagnostic covers, which is the whole point of the range. */
const marked = (source: string, errors: PositionedError[]): string[] =>
	diagnosticsFor(errors, source).map((diagnostic) => source.slice(diagnostic.from, diagnostic.to));

describe("diagnosticsFor", () => {
	it("marks a tag from its bracket to the one that closes it", () => {
		expect(marked("Hello\n<foo>x</foo>", [error(2, 1)])).toEqual(["<foo>"]);
	});

	/**
	 * The attribute and its value, and not one character more. Running to the next space swallowed the
	 * tag's own `>` and whatever followed it: `<box width=101></box>` underlined `width=101></box>`,
	 * which points at the closing tag as though it were at fault.
	 */
	it("marks an attribute without reaching past the tag it sits in", () => {
		expect(marked("<box width=101></box>", [error(1, 6)])).toEqual(["width=101"]);
	});

	it("stops at the first space where no bracket comes sooner", () => {
		expect(marked("<box width=101> and more", [error(1, 6)])).toEqual(["width=101"]);
	});

	it("marks a variable reference from its brace to its closing one", () => {
		expect(marked("Call {custmer} today", [error(1, 6)])).toEqual(["{custmer}"]);
	});

	it("marks an entity being written", () => {
		expect(marked("a &bogus b", [error(1, 3)])).toEqual(["&bogus"]);
	});

	it("reports the range as offsets into the whole document", () => {
		const [diagnostic] = diagnosticsFor([error(2, 3)], "one\ntwo\nthree");

		expect(diagnostic).toEqual({ from: 6, to: 7, severity: "error", message: "Something is wrong" });
	});

	it("carries the compiler's own message", () => {
		const [diagnostic] = diagnosticsFor([error(1, 1, "Unknown tag 'foo'")], "<foo>");

		expect(diagnostic.message).toBe("Unknown tag 'foo'");
	});

	it("marks every error it is given, in the order they arrived", () => {
		expect(marked("<foo>\n<bar>", [error(1, 1), error(2, 1)])).toEqual(["<foo>", "<bar>"]);
	});

	/**
	 * A failure that belongs to the request rather than to a line — too many output lines, a raster
	 * budget — has nowhere to point. It stays in the problems list, where it reads perfectly well.
	 */
	it("marks nothing for an error with no line", () => {
		expect(diagnosticsFor([error(null, null)], "<foo>")).toEqual([]);
	});

	it("marks the whole line for an error that names a line but no column", () => {
		expect(marked("one\ntwo long line\nthree", [error(2, null)])).toEqual(["two long line"]);
	});

	/**
	 * The preview is debounced, so its answer describes the document as it was a moment ago. A line
	 * that has since been deleted is not a line to underline.
	 */
	it("marks nothing for a line the document no longer has", () => {
		expect(diagnosticsFor([error(9, 1)], "one\ntwo")).toEqual([]);
	});

	it("clamps a column that runs past the end of its line", () => {
		expect(marked("one\ntwo", [error(1, 40)])).toEqual([""]);
	});

	it("marks nothing wider than a construct could reasonably be", () => {
		const long = "x".repeat(MAX_MARKED_CHARS + 20);

		expect(marked(long, [error(1, 1)])).toEqual([long.slice(0, MAX_MARKED_CHARS)]);
	});

	it("marks an empty line without reaching into the one below", () => {
		const [diagnostic] = diagnosticsFor([error(2, 1)], "one\n\nthree");

		expect(diagnostic).toEqual({ from: 4, to: 4, severity: "error", message: "Something is wrong" });
	});

	it("reads the last line of a document that ends without a newline", () => {
		expect(marked("one\ntwo", [error(2, 1)])).toEqual(["two"]);
	});

	it("reads a document whose lines end with a carriage return", () => {
		// `normaliseSource` strips these before compiling, so the compiler counts lines in a document
		// the editor may still hold with Windows endings. The columns have to mean the same thing.
		expect(marked("one\r\n<foo>", [error(2, 1)])).toEqual(["<foo>"]);
	});
});
