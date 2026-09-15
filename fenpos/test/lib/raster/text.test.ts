import { describe, expect, it } from "vitest";
import type { UnsupportedPolicy } from "@/lib/domain/enums";
import { UnsupportedCharacterError } from "@/lib/markup/errors";
import { PLAIN, type SpanStyle } from "@/lib/markup/model";
import { Canvas } from "@/lib/raster/canvas";
import { builtinTypeface, bundledFace, typefaceFor } from "@/lib/raster/fonts";
import { type InlineItem, layoutText, paintRows, type TextContext, type TextRow, textHeight } from "@/lib/raster/text";
import { ascii } from "../../helpers/pbm";

const context: TextContext = {
	typeface: (style) => (style.face ? typefaceFor(bundledFace(), style.faceDots) : builtinTypeface(style.font)),
	onUnsupported: "REJECT",
	codepage: "CP437",
};

const run = (text: string, style: Partial<SpanStyle> = {}): InlineItem => ({
	kind: "run",
	text,
	style: { ...PLAIN, ...style },
	column: 1,
});

/** Lays items out unwrapped and paints them at the canvas origin. */
const paint = (canvas: Canvas, items: InlineItem[], availableWidth = 504): TextRow[] => {
	const rows = layoutText(items, availableWidth, false, "LEFT", context);
	paintRows(canvas, rows, 0, 0);
	return rows;
};

const dotsInRow = (canvas: Canvas, y: number): number => {
	let dots = 0;
	for (let x = 0; x < canvas.width; x++) {
		if (canvas.get(x, y)) dots++;
	}
	return dots;
};

const dots = (canvas: Canvas): number => {
	let total = 0;
	for (let y = 0; y < canvas.height; y++) total += dotsInRow(canvas, y);
	return total;
};

/** How many `step`-wide cells between `from` and `to` carry any ink. */
const inkedCells = (canvas: Canvas, from: number, to: number, step: number): number => {
	let cells = 0;
	for (let left = from; left < to; left += step) {
		let inked = false;
		for (let x = left; x < left + step && !inked; x++) {
			for (let y = 0; y < canvas.height && !inked; y++) {
				inked = canvas.get(x, y);
			}
		}
		if (inked) cells++;
	}
	return cells;
};

describe("layoutText", () => {
	it("measures a run by its advances", () => {
		const rows = layoutText([run("abc")], 504, false, "LEFT", context);

		expect(rows).toHaveLength(1);
		expect(rows[0].width).toBe(36);
		expect(rows[0].height).toBe(24);
	});

	it("doubles width and height under size", () => {
		const rows = layoutText([run("ab", { widthMult: 2, heightMult: 3 })], 504, false, "LEFT", context);

		expect(rows[0].width).toBe(48);
		expect(rows[0].height).toBe(72);
	});

	it("wraps at a space when the row is full", () => {
		const rows = layoutText([run("aaaa bbbb cccc")], 12 * 9, true, "LEFT", context);

		expect(rows.map((row) => row.width)).toEqual([12 * 9, 12 * 4]);
	});

	it("breaks a word wider than the width", () => {
		expect(layoutText([run("abcdefgh")], 12 * 3, true, "LEFT", context)).toHaveLength(3);
	});

	it("ends on the row a dropped trailing space came from", () => {
		expect(layoutText([run("aaaa ")], 12 * 4, true, "LEFT", context).map((row) => row.width)).toEqual([48]);
	});

	it("never breaks at a space that opens a row", () => {
		const rows = layoutText([run(" abc")], 12 * 2, true, "LEFT", context);

		expect(rows.map((row) => row.width)).toEqual([24, 24]);
	});

	it("drops every space at a break, not only the first", () => {
		expect(layoutText([run("aa  bb")], 12 * 2, true, "LEFT", context).map((row) => row.width)).toEqual([24, 24]);
		expect(layoutText([run("aa   bb")], 12 * 2, true, "LEFT", context).map((row) => row.width)).toEqual([24, 24]);
	});

	it("keeps one row and overflows under nowrap", () => {
		expect(layoutText([run("abcdefgh")], 12 * 3, false, "LEFT", context)).toHaveLength(1);
	});

	it("splits slack between fills with the same remainder rule as native text", () => {
		const items: InlineItem[] = [
			run("a"),
			{ kind: "fill", character: " ", style: PLAIN, column: 1 },
			run("b"),
			{ kind: "fill", character: " ", style: PLAIN, column: 1 },
			run("c"),
		];

		const rows = layoutText(items, 12 * 10, false, "LEFT", context);

		// Slack 84 split 42/42; each fill spends three whole 12-dot cells and leaves its remainder blank.
		expect(rows[0].width).toBe(108);
		expect(rows[0].cells.map((cell) => cell.x)).toEqual([0, 12, 48, 60, 96]);
	});

	it("places the row by align", () => {
		expect(layoutText([run("ab")], 100, false, "CENTER", context)[0].cells[0].x).toBe(38);
		expect(layoutText([run("ab")], 100, false, "RIGHT", context)[0].cells[0].x).toBe(76);
	});

	it("centres a short cell in a tall row", () => {
		const rows = layoutText([run("a", { heightMult: 2 }), run("b")], 504, false, "LEFT", context);
		const canvas = new Canvas(24, 48);
		paintRows(canvas, rows, 0, 0);

		const inked = (x0: number, x1: number): number[] => {
			const ys: number[] = [];
			for (let y = 0; y < 48; y++) {
				for (let x = x0; x < x1; x++) {
					if (canvas.get(x, y)) {
						ys.push(y);
						break;
					}
				}
			}
			return ys;
		};

		expect(Math.min(...inked(12, 24))).toBeGreaterThan(10);
		expect(Math.max(...inked(12, 24))).toBeLessThan(38);
	});

	it("paints an inline image at its size", () => {
		const stamp = new Canvas(10, 5);
		stamp.fill(0, 0, 10, 5, "solid");
		const rows = layoutText([run("a"), { kind: "image", raster: stamp.pack() }], 504, false, "LEFT", context);

		expect(rows[0].width).toBe(22);
		expect(rows[0].height).toBe(24);
	});

	it("rejects a character the face lacks under REJECT, with its column", () => {
		const items: InlineItem[] = [{ kind: "run", text: "a\u{1F600}", style: PLAIN, column: 5 }];

		expect(() => layoutText(items, 504, false, "LEFT", context)).toThrow(UnsupportedCharacterError);
		try {
			layoutText(items, 504, false, "LEFT", context);
		} catch (error) {
			expect((error as UnsupportedCharacterError).column).toBe(6);
		}
	});

	/**
	 * A fill's character is a character the caller wrote, at a column their line really has, so it
	 * answers to the unsupported policy exactly as a run's does rather than quietly buying nothing.
	 */
	it("applies the unsupported policy to a fill's character too", () => {
		const items: InlineItem[] = [run("a"), { kind: "fill", character: "\u{1F600}", style: PLAIN, column: 3 }];

		try {
			layoutText(items, 504, false, "LEFT", context);
			expect.unreachable("expected the fill's character to be rejected");
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedCharacterError);
			expect((error as UnsupportedCharacterError).column).toBe(3);
		}

		const widthUnder = (onUnsupported: UnsupportedPolicy): number =>
			layoutText(items, 504, false, "LEFT", { ...context, onUnsupported })[0].cells[1].width;

		// The replacement is a real glyph and buys whole cells of the width left over; stripping it
		// leaves the fill with no character to stamp, so it buys nothing at all.
		expect(widthUnder("REPLACE")).toBe(492);
		expect(widthUnder("STRIP")).toBe(0);
	});

	it("replaces under REPLACE and strips under STRIP", () => {
		const widthUnder = (onUnsupported: UnsupportedPolicy): number =>
			layoutText([run("a\u{1F600}")], 504, false, "LEFT", { ...context, onUnsupported })[0].width;

		expect(widthUnder("REPLACE")).toBe(24);
		expect(widthUnder("STRIP")).toBe(12);
	});

	it("underlines and inverts", () => {
		const rows = layoutText([run("a", { underline: 1 }), run("b", { invert: true })], 504, false, "LEFT", context);
		const canvas = new Canvas(24, 24);
		paintRows(canvas, rows, 0, 0);
		const text = ascii(canvas.pack());

		expect(text.split("\n")[builtinTypeface("A").ascent + 2].slice(0, 12)).toBe("############");
		expect(text.split("\n")[0].slice(12)).toBe("############");
	});

	it("reports the total height", () => {
		expect(textHeight(layoutText([run("aaaa bbbb")], 12 * 4, true, "LEFT", context))).toBe(48);
	});
});

describe("paintRows", () => {
	it("thickens a bold glyph by exactly one dot on every inked row", () => {
		const plain = new Canvas(16, 24);
		const bold = new Canvas(16, 24);
		paint(plain, [run("I")]);
		paint(bold, [run("I", { bold: true })]);

		expect(dots(plain)).toBeGreaterThan(0);
		for (let y = 0; y < 24; y++) {
			const thin = dotsInRow(plain, y);
			expect(dotsInRow(bold, y), `row ${y}`).toBe(thin === 0 ? 0 : thin + 1);
		}
	});

	it("stamps a fill's character once per whole cell", () => {
		const canvas = new Canvas(72, 24);
		const items: InlineItem[] = [run("a"), { kind: "fill", character: ".", style: PLAIN, column: 1 }, run("b")];

		const rows = paint(canvas, items, 72);

		// Slack 48 buys four whole 12-dot cells, each carrying one period.
		expect(rows[0].cells[1].width).toBe(48);
		expect(inkedCells(canvas, 12, 60, 12)).toBe(4);
		// The fill neither overruns its span nor leaves a cell of it blank: a, four periods, b.
		expect(inkedCells(canvas, 0, 72, 12)).toBe(6);
	});

	it("blits an inline image at its cell, vertically centred", () => {
		const stamp = new Canvas(10, 5);
		stamp.fill(0, 0, 10, 5, "solid");
		const canvas = new Canvas(24, 24);

		paint(canvas, [run("a"), { kind: "image", raster: stamp.pack() }]);

		// A 5-dot stamp in a 24-dot row sits at floor((24 - 5) / 2), beside the 12-dot glyph cell.
		const painted = ascii(canvas.pack()).split("\n");
		expect(painted[8].slice(12, 22)).toBe(".".repeat(10));
		for (let y = 9; y < 14; y++) {
			expect(painted[y].slice(12, 22), `row ${y}`).toBe("#".repeat(10));
		}
		expect(painted[14].slice(12, 22)).toBe(".".repeat(10));
	});

	it("scales a glyph by whole dots, leaving no gaps", () => {
		const plain = new Canvas(12, 24);
		const scaled = new Canvas(24, 48);
		paint(plain, [run("I")]);
		paint(scaled, [run("I", { widthMult: 2, heightMult: 2 })]);

		for (let y = 0; y < 24; y++) {
			for (let x = 0; x < 12; x++) {
				if (!plain.get(x, y)) continue;
				for (let dy = 0; dy < 2; dy++) {
					for (let dx = 0; dx < 2; dx++) {
						expect(scaled.get(2 * x + dx, 2 * y + dy), `dot ${x},${y} block ${dx},${dy}`).toBe(true);
					}
				}
			}
		}

		expect(dots(plain)).toBeGreaterThan(0);
		expect(dots(scaled)).toBe(dots(plain) * 4);
	});
});
