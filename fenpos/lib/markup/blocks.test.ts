import bwip from "bwip-js/node";
import { describe, expect, it } from "vitest";
import { BarcodeSystem } from "@/lib/domain/enums";
import {
	dotWidth,
	LINE_HEIGHT_DOTS,
	SymbolEncodeError,
	symbolGeometry,
	symbolSvg,
	validateSymbolContent,
} from "@/lib/markup/blocks";

describe("dotWidth", () => {
	it("is twelve dots per column", () => {
		expect(dotWidth(42)).toBe(504);
		expect(dotWidth(32)).toBe(384);
	});
});

describe("symbolGeometry", () => {
	it("scales a QR code with its module size", () => {
		const small = symbolGeometry({ kind: "QR", content: "https://example.com/o/123", size: 4 });
		const large = symbolGeometry({ kind: "QR", content: "https://example.com/o/123", size: 8 });
		expect(large.heightDots).toBe(small.heightDots * 2);
	});

	it("grows a QR code as its content grows", () => {
		const short = symbolGeometry({ kind: "QR", content: "A", size: 6 });
		const long = symbolGeometry({ kind: "QR", content: "A".repeat(200), size: 6 });
		expect(long.heightDots).toBeGreaterThan(short.heightDots);
	});

	it("reports height in whole lines, rounded up", () => {
		const geometry = symbolGeometry({ kind: "QR", content: "https://example.com/o/123", size: 6 });
		expect(geometry.heightLines).toBe(Math.ceil(geometry.heightDots / LINE_HEIGHT_DOTS));
		expect(geometry.heightLines).toBeGreaterThan(0);
	});

	/**
	 * The server measured one code set and the agent printed another.
	 *
	 * bwip-js selects Code 128's code set automatically and packs two digits into one character in
	 * set C, so it encoded sixteen digits in 123 modules — 246 dots. `EscPosRenderer.barcodeData`
	 * forces set B, which is one character per character throughout, so the printer laid down 211
	 * modules — 422 dots. On 58mm paper that is a preview drawing 64% of the sheet against a
	 * printer covering 110%, and the over-wide check saw only the 64%.
	 *
	 * Pinned at the exact number rather than as an inequality: a measurement that fell back to
	 * bwip-js for digits would give 246 and fail here.
	 */
	it("measures CODE128 in the code set the agent forces, not the one bwip-js picks", () => {
		expect(symbolGeometry({ kind: "BARCODE", content: "1234567890123456", system: "CODE128" }).widthDots).toBe(422);
	});

	/**
	 * The formula against a real Code 128 encoding.
	 *
	 * bwip-js has no way to be told which code set to use, so the arithmetic cannot be checked
	 * against it directly — but bwip-js *chooses* set B whenever the content is not digit-heavy, and
	 * on those inputs its own module count is ground truth for `11n + 35`. Every string below is one
	 * bwip-js encodes in set B of its own accord. If the formula's fixed cost or its per-character
	 * cost were wrong, these would disagree.
	 */
	it("matches bwip-js wherever bwip-js chooses set B by itself", () => {
		for (const content of ["A", "AB", "ABCDEFGH", "Hello World", "abc-def_1"]) {
			const symbol = bwip.raw({ bcid: "code128", text: content, includetext: false })[0];
			if (!("sbs" in symbol)) {
				throw new Error(`bwip-js did not return bar widths for '${content}'`);
			}
			const modules = symbol.sbs.reduce((total, width) => total + width, 0);
			expect(symbolGeometry({ kind: "BARCODE", content, system: "CODE128" }).widthDots, content).toBe(modules * 2);
			expect(modules, `${content} must be 11n + 35`).toBe(11 * content.length + 35);
		}
	});

	it("refuses an EAN13 that is not thirteen digits", () => {
		expect(validateSymbolContent({ kind: "BARCODE", content: "123", system: "EAN13" })).toMatch(/13/);
		expect(validateSymbolContent({ kind: "BARCODE", content: "5901234123457", system: "EAN13" })).toBeNull();
	});

	it("refuses letters in a numeric symbology", () => {
		expect(validateSymbolContent({ kind: "BARCODE", content: "ABCDEFGHIJKLM", system: "EAN13" })).not.toBeNull();
	});

	/**
	 * Interleaved 2 of 5 encodes digits in pairs, so an odd count has nothing to pair the last
	 * digit with and the agent's encoder refuses it. Accepting it here only moved that refusal
	 * from a positioned compile error to a job that failed after being acknowledged.
	 */
	it("refuses an ITF with an odd number of digits", () => {
		expect(validateSymbolContent({ kind: "BARCODE", content: "12345", system: "ITF" })).toMatch(/even/);
		expect(validateSymbolContent({ kind: "BARCODE", content: "123456", system: "ITF" })).toBeNull();
	});

	/**
	 * Two encoders have to agree about a UPC-E: bwip-js measures it, escpos-coffee prints it, and
	 * they accept different strings. `1234567` measures here and is refused on the agent, which is
	 * the failure the rule exists to stop; `123456` is the reverse. The accepted form is the
	 * overlap, and both rejections are asserted so narrowing the rule to one encoder fails.
	 */
	it("refuses a UPCE that only one of the two encoders accepts", () => {
		expect(validateSymbolContent({ kind: "BARCODE", content: "1234567", system: "UPCE" })).not.toBeNull();
		expect(validateSymbolContent({ kind: "BARCODE", content: "123456", system: "UPCE" })).not.toBeNull();
		expect(validateSymbolContent({ kind: "BARCODE", content: "0123456", system: "UPCE" })).toBeNull();
	});

	/**
	 * And the overlap is real, not just agreed on paper: the accepted form measures without the
	 * encoder throwing. A check digit is arithmetic rather than format, so it stays the encoder's
	 * to report, exactly as it is for EAN13 above.
	 */
	it("measures the UPCE form it accepts", () => {
		expect(symbolGeometry({ kind: "BARCODE", content: "0123456", system: "UPCE" }).heightLines).toBe(5);
	});

	/**
	 * Not a limit of QR or PDF417, both of which encode arbitrary bytes. It is a limit of the
	 * agent: escpos-coffee declares the symbol's payload length in characters while writing UTF-8
	 * bytes, so one character above U+007F leaves the printer reading a truncated payload as a
	 * valid symbol. It scans, and it scans as the wrong thing — refused here so the caller gets a
	 * position rather than a receipt.
	 */
	it("refuses non-ASCII content in a two-dimensional symbol", () => {
		expect(validateSymbolContent({ kind: "QR", content: "kahvi ä", size: 6 })).toMatch(/ASCII/);
		expect(validateSymbolContent({ kind: "PDF417", content: "kahvi ä", errorLevel: 1 })).toMatch(/ASCII/);
	});

	it("accepts the whole ASCII range in a two-dimensional symbol", () => {
		// The bound is ASCII, not "letters and digits": a URL's punctuation must survive it.
		expect(validateSymbolContent({ kind: "QR", content: "https://x.test/a?b=1&c=~", size: 6 })).toBeNull();
	});

	/**
	 * Code 128 has no alphabet of its own — it covers printable ASCII and the agent escapes rather
	 * than interprets what it is given — so its rule was once "non-empty" and nothing more. That
	 * left the one gap the other rules exist to close: bwip-js measures `café` without complaint,
	 * so the server acknowledged the job, and escpos-coffee then refused it against
	 * `^\{[A-C][\x00-\x7F]+$` on the agent. A 202 for a job that cannot print is the single
	 * outcome this API promises does not happen.
	 *
	 * The measurement is asserted alongside the refusal on purpose: without it this test would
	 * still pass if bwip-js were the one rejecting the content, which would make the rule look
	 * like belt and braces rather than the only thing standing between a caller and that 202.
	 */
	it("refuses non-ASCII CODE128 content that the encoder would happily measure", () => {
		expect(symbolGeometry({ kind: "BARCODE", content: "café", system: "CODE128" }).heightLines).toBe(5);
		expect(validateSymbolContent({ kind: "BARCODE", content: "café", system: "CODE128" })).toMatch(/ASCII/);
		expect(validateSymbolContent({ kind: "BARCODE", content: "cafe", system: "CODE128" })).toBeNull();
	});

	/**
	 * The same bound across every symbology, which the other eight hold by their own alphabets
	 * rather than by an ASCII check: each is digits or a named ASCII character class, so none can
	 * admit a character the agent's regex would then reject. Written as a sweep so a symbology
	 * added later with a broader alphabet fails here rather than on a printer, and substituting
	 * the last character rather than appending one so each sample stays a legal length and the
	 * refusal is about the character rather than the count.
	 */
	it("admits no non-ASCII content in any symbology", () => {
		for (const system of BarcodeSystem.values) {
			const content = `${BARCODE_SAMPLES[system].slice(0, -1)}ä`;
			expect(validateSymbolContent({ kind: "BARCODE", content, system })).not.toBeNull();
		}
	});

	it("measures an EAN13 barcode at the spec's fixed 100-dot height", () => {
		const geometry = symbolGeometry({ kind: "BARCODE", content: "5901234123457", system: "EAN13" });
		expect(geometry.heightLines).toBe(5);
	});

	/**
	 * The seam that lets a caller's mistake be told apart from this module's own.
	 *
	 * `validateSymbolContent` passes a 13-digit EAN13 because its format is right; the encoder
	 * then rejects it because the last digit is not the check digit the first twelve imply. That
	 * is a client mistake, so it gets a type of its own, and the identifier bwip-js stamps on its
	 * message is stripped here rather than travelling out into an API response.
	 */
	it("names an encoder refusal as one, without bwip-js's internal identifier", () => {
		let thrown: unknown;
		try {
			symbolGeometry({ kind: "BARCODE", content: "1234567890123", system: "EAN13" });
		} catch (caught) {
			thrown = caught;
		}

		expect(thrown).toBeInstanceOf(SymbolEncodeError);
		expect((thrown as SymbolEncodeError).message).toBe("Incorrect EAN-13 check digit provided");
		expect((thrown as SymbolEncodeError).cause).toBeInstanceOf(Error);
	});

	it("grows a PDF417 with its content", () => {
		const short = symbolGeometry({ kind: "PDF417", content: "ORDER-1", errorLevel: 1 });
		const long = symbolGeometry({ kind: "PDF417", content: "ORDER-1|".repeat(30), errorLevel: 1 });
		expect(long.heightDots).toBeGreaterThan(short.heightDots);
	});

	it("measures a PDF417 in the same dots-per-module scale on both axes as the encoder itself", async () => {
		const content = "ORDER-1|".repeat(30);
		const errorLevel = 1;

		// Ground truth: bwip-js's own rendered pixel dimensions at scale:1, i.e. one pixel per
		// module in both directions. If symbolGeometry scaled width and height by different
		// per-module dot constants, the two axes would stop being proportional to this render.
		// Built as a variable, not an inline literal, since `eclevel` isn't in bwip-js's typed
		// RenderOptions even though the encoder accepts it (see the same pattern in blocks.ts).
		const renderOptions = { bcid: "pdf417", text: content, eclevel: errorLevel, scale: 1, includetext: false };
		const rendered = await bwip.toBuffer(renderOptions);
		const renderedWidth = rendered.readUInt32BE(16);
		const renderedHeight = rendered.readUInt32BE(20);

		const geometry = symbolGeometry({ kind: "PDF417", content, errorLevel });
		const dotsPerModule = geometry.widthDots / renderedWidth;

		expect(geometry.heightDots).toBe(renderedHeight * dotsPerModule);
	});
});

/**
 * Tests for the symbol the paper preview draws.
 *
 * The question they answer is the only one that matters about a drawn symbol: does it carry exactly
 * what was typed? Looking at it cannot answer that — a QR code encoding the wrong URL looks
 * precisely like one encoding the right one — so the SVG is read back into the marks it paints and
 * compared against what the encoder makes of that same string. What a scanner reads off the screen
 * is those marks.
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

/** bwip-js's own identifier for each symbology, as ground truth independent of `blocks.ts`. */
const SAMPLE_BCID: Record<BarcodeSystem, string> = {
	UPCA: "upca",
	UPCE: "upce",
	EAN13: "ean13",
	EAN8: "ean8",
	CODE39: "code39",
	ITF: "interleaved2of5",
	CODABAR: "rationalizedCodabar",
	CODE93: "code93",
	CODE128: "code128",
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
 * Reads a two-dimensional symbol's SVG back into the grid of modules it paints.
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

/**
 * Reads a linear barcode's SVG back into its sequence of bar and space widths.
 *
 * A barcode is drawn as vertical strokes, grouped into one path per bar width, so a bar's extent is
 * its stroke's centre plus or minus half the stroke width. The spaces are the gaps between them.
 * Widths come back in narrow-bar units, taking the narrowest stroke as the narrow bar.
 *
 * @param svg the SVG document
 * @returns the alternating bar and space widths, starting with the first bar
 */
function barSequence(svg: string): number[] {
	const bars: { left: number; right: number; width: number }[] = [];
	for (const path of svg.matchAll(/stroke-width="([\d.]+)" d="([^"]+)"/g)) {
		const width = Number(path[1]);
		for (const bar of path[2].matchAll(/M([\d.]+) [\d.]+L/g)) {
			const centre = Number(bar[1]);
			bars.push({ left: centre - width / 2, right: centre + width / 2, width });
		}
	}
	if (bars.length === 0) {
		throw new Error("the symbol paints no bars");
	}
	bars.sort((first, second) => first.left - second.left);

	const narrow = Math.min(...bars.map((bar) => bar.width));
	const sequence: number[] = [];
	let previousRight = bars[0].left;
	for (const bar of bars) {
		if (bar.left > previousRight) {
			sequence.push((bar.left - previousRight) / narrow);
		}
		sequence.push((bar.right - bar.left) / narrow);
		previousRight = bar.right;
	}
	return sequence;
}

/**
 * Replaces each width with its rank among the widths present.
 *
 * Compared this way because a symbology's *pattern* of narrow and wide elements is what encodes the
 * data, while the ratio between them is a rendering choice — and bwip-js does not always render it
 * at the ratio `raw()` reports. Interleaved 2 of 5 is the case in point: `raw()` calls a wide bar
 * two narrow bars, the renderer draws it three. Ranking compares what the symbol says rather than
 * how boldly it says it.
 */
function ranked(widths: number[]): number[] {
	const distinct = [...new Set(widths)].sort((first, second) => first - second);
	return widths.map((width) => distinct.indexOf(width) + 1);
}

describe("symbolSvg", () => {
	it("draws the QR code the encoder makes of exactly the content typed", () => {
		const content = "https://cafe.example/o/123";

		const expected = encodedModules({ bcid: "qrcode", text: content });
		const drawn = modules(symbolSvg({ kind: "QR", content, size: 6 }), expected.columns, expected.rows);

		expect(drawn).toEqual(expected.grid);
	});

	it("draws a different QR code for different content", () => {
		const first = symbolSvg({ kind: "QR", content: "https://cafe.example/o/123", size: 6 });
		const second = symbolSvg({ kind: "QR", content: "https://cafe.example/o/124", size: 6 });

		expect(first).not.toEqual(second);
	});

	it("draws the same QR code whatever module size it will print at", () => {
		// The module size is a printed dimension, not part of the encoding: the same URL is the same
		// grid whether it prints small or large, and the drawn size comes from the charged geometry.
		const small = symbolSvg({ kind: "QR", content: "https://cafe.example/o/123", size: 2 });
		const large = symbolSvg({ kind: "QR", content: "https://cafe.example/o/123", size: 12 });

		expect(small).toEqual(large);
	});

	it("carries the PDF417 error level into the symbol", () => {
		const content = "ORDER-123|TABLE-4";

		const expected = encodedModules({ bcid: "pdf417", text: content, eclevel: 4 });
		const drawn = modules(symbolSvg({ kind: "PDF417", content, errorLevel: 4 }), expected.columns, expected.rows);

		expect(drawn).toEqual(expected.grid);
		// Non-vacuous only if a different level really is a different symbol.
		expect(symbolSvg({ kind: "PDF417", content, errorLevel: 1 })).not.toEqual(
			symbolSvg({ kind: "PDF417", content, errorLevel: 4 }),
		);
	});

	it("draws every barcode system as the symbology and content it was given", () => {
		for (const system of BarcodeSystem.values) {
			const content = BARCODE_SAMPLES[system];
			const drawn = barSequence(symbolSvg({ kind: "BARCODE", content, system }));
			const symbol = bwip.raw({ bcid: SAMPLE_BCID[system], text: content })[0];
			if (!("sbs" in symbol)) {
				throw new Error(`'${system}' is not a linear barcode`);
			}

			// A trailing space is the only element that may be missing: it is the gap after the last
			// bar, which is real in the encoding and invisible in the ink.
			const encoded = Array.from(symbol.sbs);
			expect(encoded.length - drawn.length, system).toBeLessThanOrEqual(1);
			expect(ranked(drawn), system).toEqual(ranked(encoded.slice(0, drawn.length)));
		}
	});

	it("draws no human-readable text beside a barcode", () => {
		for (const system of BarcodeSystem.values) {
			const svg = symbolSvg({ kind: "BARCODE", content: BARCODE_SAMPLES[system], system });

			// bwip-js draws its digits as filled glyph outlines rather than as `<text>`, so what says
			// there are none is that nothing in the symbol is filled: a barcode is bars, and a bar is
			// a stroke. The printer prints no text under these, and neither may the preview.
			expect(svg, system).not.toContain('fill="');
			expect(svg, system).toContain("stroke-width=");
		}
	});

	it("emits an SVG an <img> can parse", () => {
		const svg = symbolSvg({ kind: "QR", content: "https://cafe.example/o/123", size: 6 });

		// bwip-js writes `fill=rule="evenodd"`, which is fatal to the XML parser an <img> uses.
		expect(svg).not.toContain("fill=rule=");
		expect(svg).toContain('fill-rule="evenodd"');
		expect(svg.trimStart()).toMatch(/^<svg viewBox="0 0 \d+ \d+"/);
	});

	it("names an encoder refusal as one, exactly as measuring does", () => {
		expect(() => symbolSvg({ kind: "BARCODE", content: "1234567890123", system: "EAN13" })).toThrow(SymbolEncodeError);
	});
});
