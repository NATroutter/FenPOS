import { describe, expect, it } from "vitest";
import {
	type CompileLimits,
	type CompileSettings,
	compile,
	countTextLines,
	layOut,
	readRequest,
} from "@/lib/markup/compiler";
import { MarkupError } from "@/lib/markup/errors";
import { parseDocument } from "@/lib/markup/parser";
import { DEFAULT_LIMITS } from "@/lib/settings/settings-service";

/**
 * What a list prints.
 *
 * Asserted on the laid-out lines rather than on the tree, because everything a list is about is
 * arithmetic that only the paper settles: which column a marker is right-aligned into, where a wrapped
 * entry continues, how far a nested list is set in. A test against the tree would pass while the
 * receipt printed its numbers ragged.
 */

const settings: CompileSettings = {
	columns: 32,
	codepage: "CP858",
	onUnsupported: "REJECT",
	defaultWrap: true,
	defaultLinefeed: "LF",
	images: new Map(),
	fonts: new Map(),
	variables: null,
};

const limits: CompileLimits = { ...DEFAULT_LIMITS, maxLineChars: 200, maxTotalChars: 4000 };

/** The text of each printed line, as the device would put it on paper. */
function printed(markup: string, columns = 32): string[] {
	const request = readRequest({ data: markup }, settings, 200);
	return layOut(request, { ...settings, columns }, limits).map((line) => line.spans.map((span) => span.text).join(""));
}

/** The refusal a markup raises while its tree is built. */
function refusal(markup: string): MarkupError {
	try {
		parseDocument(markup);
	} catch (thrown) {
		if (thrown instanceof MarkupError) {
			return thrown;
		}
		throw thrown;
	}
	throw new Error("expected the markup to be refused");
}

describe("a dash list", () => {
	it("prints one entry per line, marker and all", () => {
		expect(
			printed(`<list style=dash>
	<item>Milk</item>
	<item>Bread</item>
</list>`),
		).toEqual(["- Milk", "- Bread"]);
	});

	it("is what a list with no style prints", () => {
		expect(printed("<list>\n\t<item>Milk</item>\n</list>")).toEqual(["- Milk"]);
	});

	it("reads a list written along one line", () => {
		expect(printed("<list><item>Milk</item><item>Bread</item></list>")).toEqual(["- Milk", "- Bread"]);
	});

	it("prints its marker for an entry with nothing in it", () => {
		expect(printed("<list>\n\t<item></item>\n</list>")).toEqual(["-"]);
	});

	it("leaves the lines around it alone", () => {
		expect(printed("Shopping\n<list>\n\t<item>Milk</item>\n</list>\nThanks")).toEqual(["Shopping", "- Milk", "Thanks"]);
	});

	it("keeps the styling written inside an entry", () => {
		const request = readRequest({ data: "<list>\n\t<item><bold>Milk</bold></item>\n</list>" }, settings, 200);
		const [line] = layOut(request, settings, limits);

		expect(line.spans.map((span) => [span.text, span.style.bold])).toEqual([
			["- ", false],
			["Milk", true],
		]);
	});
});

describe("a numbered list", () => {
	it("counts from one", () => {
		expect(printed("<list style=number>\n\t<item>a</item>\n\t<item>b</item>\n</list>")).toEqual(["1. a", "2. b"]);
	});

	it("counts from start", () => {
		expect(printed("<list style=number start=8>\n\t<item>a</item>\n\t<item>b</item>\n</list>")).toEqual([
			"8. a",
			"9. b",
		]);
	});

	/**
	 * The reason the expansion reads a whole list rather than one entry at a time: the marker column is
	 * as wide as the last number needs, so the first entry has to know there will be a tenth.
	 */
	it("right-aligns every marker in the column the widest one needs", () => {
		expect(
			printed(
				`<list style=number start=8>
	<item>Preheat the oven</item>
	<item>Mix the dry ingredients</item>
	<item>Bake</item>
</list>`,
			),
		).toEqual([" 8. Preheat the oven", " 9. Mix the dry ingredients", "10. Bake"]);
	});
});

describe("a lettered list", () => {
	it("counts in letters", () => {
		expect(printed("<list style=letter>\n\t<item>a</item>\n\t<item>b</item>\n</list>")).toEqual(["a. a", "b. b"]);
	});

	it("goes on to aa past z", () => {
		expect(printed("<list style=letter start=26>\n\t<item>0</item>\n\t<item>1</item>\n</list>")).toEqual([
			" z. 0",
			"aa. 1",
		]);
	});
});

describe("a wrapped entry", () => {
	it("continues under its own text rather than under its marker", () => {
		expect(
			printed(
				`<list style=number start=8>
	<item>Call the plumber about the kitchen tap before Friday</item>
	<item>Bake</item>
	<item>Rest</item>
</list>`,
			),
		).toEqual([" 8. Call the plumber about the", "    kitchen tap before Friday", " 9. Bake", "10. Rest"]);
	});

	it("prints as written when the line does not wrap", () => {
		const lines = printed("<nowrap><list>\n\t<item>aaaa bbbb cccc dddd eeee ffff</item>\n</list></nowrap>", 10);

		expect(lines[0]).toBe("- aaaa bbbb cccc dddd eeee ffff");
	});

	it("still prints when the paper leaves no room for the indent", () => {
		// Clamped rather than refused: how deep a list nests is the author's and how wide the paper is
		// belongs to the device, so a list one printer has room for is one another does not.
		expect(printed("<list>\n\t<item>abcd</item>\n</list>", 2)).toEqual(["-", " a", " b", " c", " d"]);
	});
});

describe("a nested list", () => {
	it("is set in by the width of its parent's marker column", () => {
		expect(
			printed(
				`<list style=dash>
	<item>Coffee
		<list style=number>
			<item>Beans</item>
			<item>Filters</item>
		</list>
	</item>
	<item>Bread</item>
</list>`,
			),
		).toEqual(["- Coffee", "  1. Beans", "  2. Filters", "- Bread"]);
	});

	it("numbers from its own start", () => {
		expect(
			printed(
				`<list style=number>
	<item>One
		<list style=number>
			<item>Inner</item>
		</list>
	</item>
	<item>Two</item>
</list>`,
			),
		).toEqual(["1. One", "   1. Inner", "2. Two"]);
	});

	it("hangs a wrapped entry under the text of that entry", () => {
		expect(
			printed(
				`<list style=dash>
	<item>Coffee
		<list style=number>
			<item>Beans ground fresh every single morning</item>
		</list>
	</item>
</list>`,
			),
		).toEqual(["- Coffee", "  1. Beans ground fresh every", "     single morning"]);
	});

	/** The author's own indentation is dropped: the columns of a list are the list's arithmetic. */
	it("prints an entry's own text again below a list nested in it", () => {
		expect(
			printed(
				`<list style=dash>
	<item>Coffee
		<list style=number>
			<item>Beans</item>
		</list>
		Ask about decaf
	</item>
</list>`.replaceAll("\t", "  "),
			),
		).toEqual(["- Coffee", "  1. Beans", "  Ask about decaf"]);
	});
});

describe("a check list", () => {
	/** Drawn rather than printed, so the whole line crosses the wire as a picture of itself. */
	it("draws every entry", () => {
		const request = readRequest(
			{ data: "<list style=check>\n\t<item>Mop</item>\n\t<item done=on>Bins</item>\n</list>" },
			settings,
			200,
		);
		const lines = layOut(request, settings, limits);

		expect(lines.slice(0, 2).map((line) => line.directives.map((directive) => directive.kind))).toEqual([
			["RASTER"],
			["RASTER"],
		]);
		expect(lines[0].spans).toEqual([]);
	});
});

describe("a rule's character", () => {
	/**
	 * Read off the finished job rather than the laid-out lines: a rule is still a directive at that
	 * stage and becomes characters only on the way to the wire, where the paper's width is known.
	 */
	const ruled = (markup: string, columns = 8): string => {
		const request = readRequest({ data: markup }, settings, 200);
		const job = compile("job-1", "kitchen", request, limits, { ...settings, columns });
		return job.lines[0].spans.map((span) => span.text).join("");
	};

	it("is a dash when the tag does not say", () => {
		expect(ruled("<hr>")).toBe("--------");
	});

	it("is whatever char names", () => {
		expect(ruled("<hr char=*>")).toBe("********");
	});

	it("is refused when the codepage cannot print it", () => {
		// The same answer `<fill>` gives, at the column the character was written at: a rule is one
		// character repeated, and it is expanded long after the codepage check would have seen it.
		const request = readRequest({ data: "<hr char=☃>" }, settings, 200);
		let thrown: unknown = null;
		try {
			layOut(request, settings, limits);
		} catch (error) {
			thrown = error;
		}

		expect((thrown as { code?: string }).code).toBe("unsupported_character");
	});
});

describe("a list inside a region", () => {
	/**
	 * The one place a list is expanded somewhere other than `splitLines`: a box draws its own lines, so
	 * the list inside it never reaches the top-level split that would otherwise have expanded it.
	 */
	it("is drawn as rows of the box that holds it", () => {
		const request = readRequest(
			{ data: "<box>\n<list style=number>\n\t<item>Flat white</item>\n\t<item>Croissant</item>\n</list>\n</box>" },
			settings,
			200,
		);
		const [line] = layOut(request, settings, limits);
		const [directive] = line.directives;

		expect(directive.kind).toBe("RASTER");
		// Two entries, each a row of the box's own flow, plus the border and the padding around them.
		expect(directive.kind === "RASTER" && directive.raster.heightDots).toBeGreaterThan(2 * 24);
	});
});

describe("what a list refuses", () => {
	it("refuses text written straight into a list", () => {
		const error = refusal("<list>\nMilk\n</list>");

		expect(error.code).toBe("misplaced_block");
		expect(error.message).toBe("<list> holds <item> rather than text");
	});

	it("refuses an item written outside a list", () => {
		expect(refusal("<item>Milk</item>").message).toBe("<item> belongs directly inside <list>");
	});

	it("refuses anything before a list on its line", () => {
		const error = refusal("Shopping <list>\n\t<item>Milk</item>\n</list>");

		expect(error.code).toBe("invalid_block_scope");
		expect(error.message).toBe("<list> must enclose whole lines, so nothing may precede it");
	});

	it("refuses anything after a list on its line", () => {
		expect(refusal("<list>\n\t<item>Milk</item>\n</list> and more").code).toBe("invalid_block_scope");
	});

	it("refuses a region inside an entry, which would print below its marker", () => {
		const error = refusal("<list>\n\t<item><box>x</box></item>\n</list>");

		expect(error.code).toBe("misplaced_block");
		expect(error.message).toBe("<box> takes a line of its own, so it cannot sit inside a list's <item>");
	});

	it("refuses a rule inside an entry", () => {
		expect(refusal("<list>\n\t<item><hr></item>\n</list>").message).toBe(
			"<hr> takes a line of its own, so it cannot sit inside a list's <item>",
		);
	});

	it("refuses a symbol inside an entry, which the printer draws for itself", () => {
		expect(refusal("<list>\n\t<item><qr>x</qr></item>\n</list>").code).toBe("misplaced_block");
	});

	it("refuses done outside a check list", () => {
		const error = refusal("<list style=number>\n\t<item done=on>a</item>\n</list>");

		expect(error.code).toBe("invalid_attribute");
		expect(error.detail).toBe("done");
		expect(error.message).toBe("<item> done crosses a checkbox, so it applies inside a <list style=check> only");
	});

	it("refuses start on a style that counts nothing", () => {
		const error = refusal("<list style=dash start=3>\n\t<item>a</item>\n</list>");

		expect(error.code).toBe("invalid_attribute");
		expect(error.detail).toBe("start");
		expect(error.message).toBe("<list> start counts from a number, so it applies to a number or letter list only");
	});

	it("refuses an unknown style", () => {
		expect(refusal("<list style=bullet>\n\t<item>a</item>\n</list>").code).toBe("invalid_attribute");
	});

	it("refuses a list nested past the depth limit", () => {
		const depth = 9;
		const open = "<list>\n<item>".repeat(depth);
		const close = "</item>\n</list>".repeat(depth);

		expect(refusal(`${open}x${close}`).code).toBe("nesting_too_deep");
	});
});

describe("a list and the line budget", () => {
	/** A list's entries are ordinary lines by the time anything counts them, wrapped ones included. */
	it("costs one printed line per entry and one more per wrapped row", () => {
		const request = readRequest(
			{ data: "<list>\n\t<item>aaaa bbbb cccc dddd eeee ffff gggg hhhh</item>\n\t<item>b</item>\n</list>" },
			settings,
			200,
		);

		expect(countTextLines(layOut(request, settings, limits), settings)).toBe(3);
	});
});
