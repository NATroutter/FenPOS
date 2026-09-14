import { describe, expect, it } from "vitest";
import type { UnsupportedPolicy } from "@/lib/domain/enums";
import { UnsupportedCharacterError } from "@/lib/markup/errors";
import { PLAIN, type SpanStyle } from "@/lib/markup/model";
import { Canvas } from "@/lib/raster/canvas";
import { builtinTypeface, bundledFace, typefaceFor } from "@/lib/raster/fonts";
import { type InlineItem, layoutText, paintRows, type TextContext, textHeight } from "@/lib/raster/text";
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

	it("keeps one row and overflows under nowrap", () => {
		expect(layoutText([run("abcdefgh")], 12 * 3, false, "LEFT", context)).toHaveLength(1);
	});

	it("splits slack between fills with the same remainder rule as native text", () => {
		const items: InlineItem[] = [
			run("a"),
			{ kind: "fill", character: " ", style: PLAIN },
			run("b"),
			{ kind: "fill", character: " ", style: PLAIN },
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
