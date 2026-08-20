import bwip from "bwip-js/browser";
import { describe, expect, it } from "vitest";
import { BARCODE_BCID, symbolSvg } from "@/components/panel/symbol-preview";
import { BarcodeSystem } from "@/lib/domain/enums";
import { type SymbolSpec, symbolGeometry } from "@/lib/markup/blocks";

/**
 * Tests for the symbol the paper preview draws.
 *
 * The question these answer is the only one that matters about a preview of a symbol: does the
 * thing on screen carry exactly what was typed? A screenshot cannot answer it — a QR code that
 * encodes the wrong URL looks precisely like one that encodes the right one — so the drawn SVG is
 * read back into the grid of modules it paints and compared against what the encoder makes of that
 * same string. What a phone reads off the screen is that grid.
 */

/** Content each symbology accepts, one sample per system. */
const BARCODE_SAMPLES: Record<BarcodeSystem, string> = {
	UPCA: "012345678905",
	UPCE: "0123456",
	EAN13: "5901234123457",
	EAN8: "96385074",
	CODE39: "ABC-123",
	ITF: "1234",
	CODABAR: "A123B",
	CODE93: "ABC-123",
	CODE128: "ABC-123",
};

/**
 * Reads the filled polygons out of an SVG.
 *
 * Every path bwip-js emits for a two-dimensional symbol is a rectilinear polygon, drawn with `M`
 * and `L` and closed with `Z`, so this needs no general path parser.
 *
 * @param svg the SVG document
 * @returns each closed subpath, as its points
 */
function polygons(svg: string): [number, number][][] {
	const shapes: [number, number][][] = [];
	for (const path of svg.matchAll(/ d="([^"]+)"/g)) {
		for (const piece of path[1].split("Z")) {
			const points: [number, number][] = [];
			for (const point of piece.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
				points.push([Number(point[1]), Number(point[2])]);
			}
			if (points.length > 2) {
				shapes.push(points);
			}
		}
	}
	return shapes;
}

/**
 * Whether a point is painted, under the even-odd rule the symbol is filled with.
 *
 * Counts how many edges a ray cast from the point crosses: an odd count is inside. Every subpath
 * counts, which is what makes a hole in a finder pattern read as white rather than black.
 */
function isFilled(shapes: [number, number][][], x: number, y: number): boolean {
	let crossings = 0;
	for (const points of shapes) {
		for (let index = 0; index < points.length; index++) {
			const [x0, y0] = points[index];
			const [x1, y1] = points[(index + 1) % points.length];
			if (y0 > y !== y1 > y && x < x0 + ((y - y0) / (y1 - y0)) * (x1 - x0)) {
				crossings++;
			}
		}
	}
	return crossings % 2 === 1;
}

/**
 * Reads an SVG back into the grid of modules it paints.
 *
 * Sampled at the centre of each module, so the answer does not depend on how the encoder rounded
 * an edge.
 *
 * @param svg the SVG document
 * @param columns the symbol's width in modules
 * @param rows the symbol's height in modules
 * @returns one 1 or 0 per module, row by row from the top, as bwip-js's own `pixs` is ordered
 */
function modules(svg: string, columns: number, rows: number): number[] {
	const box = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
	if (!box) {
		throw new Error("the symbol has no viewBox");
	}
	const unitX = Number(box[1]) / columns;
	const unitY = Number(box[2]) / rows;
	const shapes = polygons(svg);

	const grid: number[] = [];
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			grid.push(isFilled(shapes, (column + 0.5) * unitX, (row + 0.5) * unitY) ? 1 : 0);
		}
	}
	return grid;
}

/**
 * The module grid the encoder itself makes of a call, as ground truth.
 *
 * `pixs` carries one line per encoded row, while `pixy` is the symbol's drawn height: PDF417 prints
 * each of its codeword rows several modules tall, so a row is repeated to the height it is drawn at
 * rather than the two being assumed equal. For QR they are equal and the repeat is one.
 *
 * @param options the bwip-js call
 * @returns the modules the encoder paints, row by row from the top
 */
function encodedModules(options: { bcid: string; text: string; eclevel?: number }): {
	grid: number[];
	columns: number;
	rows: number;
} {
	const symbol = bwip.raw(options)[0];
	if (!("pixs" in symbol)) {
		throw new Error(`'${options.bcid}' is not a two-dimensional symbol`);
	}

	const columns = symbol.pixx;
	const rowHeight = symbol.pixy / (symbol.pixs.length / columns);
	const grid: number[] = [];
	for (let row = 0; row < symbol.pixy; row++) {
		const start = Math.floor(row / rowHeight) * columns;
		for (let column = 0; column < columns; column++) {
			grid.push(symbol.pixs[start + column]);
		}
	}
	return { grid, columns, rows: symbol.pixy };
}

describe("symbolSvg", () => {
	it("draws the QR code the encoder makes of exactly the content typed", () => {
		const content = "https://cafe.example/o/123";
		const spec: SymbolSpec = { kind: "QR", content, size: 6 };

		const expected = encodedModules({ bcid: "qrcode", text: content });
		const drawn = modules(symbolSvg(spec), expected.columns, expected.rows);

		expect(drawn).toEqual(expected.grid);
	});

	it("draws a different QR code for different content", () => {
		const first = symbolSvg({ kind: "QR", content: "https://cafe.example/o/123", size: 6 });
		const second = symbolSvg({ kind: "QR", content: "https://cafe.example/o/124", size: 6 });

		expect(first).not.toEqual(second);
	});

	it("draws the QR code at the module size the printer will use", () => {
		// The module size is a printed dimension, not part of the encoding: the same URL is the same
		// grid whether it prints small or large, and the drawn size comes from the charged height.
		const small = symbolSvg({ kind: "QR", content: "https://cafe.example/o/123", size: 2 });
		const large = symbolSvg({ kind: "QR", content: "https://cafe.example/o/123", size: 12 });

		expect(small).toEqual(large);
	});

	it("carries the PDF417 error level into the symbol", () => {
		const content = "ORDER-123|TABLE-4";
		const spec: SymbolSpec = { kind: "PDF417", content, errorLevel: 4 };

		const expected = encodedModules({ bcid: "pdf417", text: content, eclevel: 4 });
		const drawn = modules(symbolSvg(spec), expected.columns, expected.rows);

		expect(drawn).toEqual(expected.grid);
		// Non-vacuous only if a different level really is a different symbol.
		expect(symbolSvg({ kind: "PDF417", content, errorLevel: 1 })).not.toEqual(symbolSvg(spec));
	});

	it("draws the symbology the compiler measured, for every barcode system", () => {
		// Both sides are asked for the same quantity — the symbol's width in modules — so a system
		// the preview drew as some other symbology would come back a different width, and its ratio
		// would fall out of line with the other eight.
		const ratios = new Set(
			BarcodeSystem.values.map((system) => {
				const content = BARCODE_SAMPLES[system];
				const measured = symbolGeometry({ kind: "BARCODE", content, system }).widthDots;
				const symbol = bwip.raw({ bcid: BARCODE_BCID[system], text: content })[0];
				if (!("sbs" in symbol)) {
					throw new Error(`'${system}' did not draw as a linear barcode`);
				}
				return measured / symbol.sbs.reduce((total, width) => total + width, 0);
			}),
		);

		expect(ratios.size).toBe(1);
		expect([...ratios][0]).toBeGreaterThan(0);
	});

	it("emits an SVG an <img> can parse", () => {
		const svg = symbolSvg({ kind: "QR", content: "https://cafe.example/o/123", size: 6 });

		// bwip-js writes `fill=rule="evenodd"`, which is fatal to the XML parser an <img> uses.
		expect(svg).not.toContain("fill=rule=");
		expect(svg).toContain('fill-rule="evenodd"');
		expect(svg.trimStart()).toMatch(/^<svg viewBox="0 0 \d+ \d+"/);
	});
});
