import bwip from "bwip-js/node";
import type { BarcodeSystem } from "@/lib/domain/enums";

/**
 * How big a QR code, barcode or PDF417 symbol prints, in printer dots.
 *
 * This module exists because two very different consumers need to agree on the same number.
 * The markup compiler charges a symbol's printed height against a job's `maxOutputLines`
 * budget before anything reaches a printer; the on-screen paper preview draws that same symbol
 * at that same height. Both call {@link symbolGeometry} rather than compute a height
 * themselves, so the budget a request is checked against and the height the preview draws
 * cannot disagree.
 *
 * Measurement is delegated to `bwip-js` rather than reimplementing QR/PDF417/barcode sizing.
 * Its `raw()` call is synchronous and describes a symbol's shape before any rendering happens,
 * but in two different vocabularies depending on the symbol:
 *  - For 2D symbols (QR, PDF417) it returns a module matrix — `{ pixx, pixy, ... }`, the
 *    symbol's width and height in modules. Dots are `modules * dots-per-module`.
 *  - For linear barcodes it returns `{ sbs, bhs, bbs }` instead: `sbs` is the sequence of
 *    bar/space widths in narrow-bar units, which sum to the symbol's width in modules. There is
 *    no module matrix for a 1D symbol, because unlike a 2D code its height is not a property of
 *    the encoded data — it is purely a device setting — so height is a fixed constant below
 *    rather than anything read from `bwip-js`.
 */

/** Height of one printed line at the default font (Font A). */
export const LINE_HEIGHT_DOTS = 24;

/** Dots per printer column at the default font. */
const DOTS_PER_COLUMN = 12;

/**
 * Converts a width in printer columns to dots.
 *
 * @param columns a width in printer columns
 * @returns the same width in dots
 */
export function dotWidth(columns: number): number {
	return columns * DOTS_PER_COLUMN;
}

/**
 * One symbol to measure or validate.
 *
 * A discriminated input rather than a positional `option`, because the option means a module
 * size for QR, a symbology for a barcode and an error level for PDF417 — three unrelated things
 * that a single `number` parameter would silently let a caller swap.
 */
export type SymbolSpec =
	| { kind: "QR"; content: string; size: number }
	| { kind: "BARCODE"; content: string; system: BarcodeSystem }
	| { kind: "PDF417"; content: string; errorLevel: number };

/** The printed size of one symbol. */
export interface SymbolGeometry {
	widthDots: number;
	heightDots: number;
	/** {@link heightDots}, rounded up to a whole line, since paper only advances by whole lines. */
	heightLines: number;
}

/** bwip-js's `bcid` identifier for each symbology, used in `raw()` calls. */
const BARCODE_BCID: Record<BarcodeSystem, string> = {
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
 * Dots per PDF417 module, in both directions.
 *
 * `bwip.raw()`'s `pixx`/`pixy` for PDF417 are already module-scaled and share one unit system —
 * confirmed against `toBuffer(..., {scale:1})`'s rendered PNG dimensions, which match `pixx`x
 * `pixy` exactly (e.g. 103x15 and 205x66 for two different inputs). There is no separate "row
 * height" to derive: applying a different multiplier to `pixy` than to `pixx` would rescale one
 * axis relative to the other for no reason bwip's own output supports.
 */
const PDF417_MODULE_DOTS = 3;

/** Dots per narrow-bar module in a linear barcode. */
const BARCODE_MODULE_WIDTH_DOTS = 2;

/**
 * Printed height of a linear barcode, fixed regardless of symbology or content.
 *
 * Unlike a QR code or PDF417, a 1D barcode's height carries no data — it is purely a device
 * setting (ESC/POS's `GS h`). 100 dots is the spec's stated default, `ceil(100 / 24)` = 5
 * printed lines.
 */
const BARCODE_HEIGHT_DOTS = 100;

/**
 * Measures the printed size of a symbol.
 *
 * @param spec what to print
 * @returns its width and height in dots, and its height in whole printed lines
 */
export function symbolGeometry(spec: SymbolSpec): SymbolGeometry {
	switch (spec.kind) {
		case "QR": {
			const grid = moduleGrid("qrcode", spec.content);
			return toGeometry(grid.pixx * spec.size, grid.pixy * spec.size);
		}
		case "PDF417": {
			const grid = moduleGrid("pdf417", spec.content, { eclevel: spec.errorLevel });
			return toGeometry(grid.pixx * PDF417_MODULE_DOTS, grid.pixy * PDF417_MODULE_DOTS);
		}
		case "BARCODE": {
			const widthModules = barModuleWidth(BARCODE_BCID[spec.system], spec.content);
			return toGeometry(widthModules * BARCODE_MODULE_WIDTH_DOTS, BARCODE_HEIGHT_DOTS);
		}
	}
}

function toGeometry(widthDots: number, heightDots: number): SymbolGeometry {
	return {
		widthDots,
		heightDots,
		heightLines: Math.ceil(heightDots / LINE_HEIGHT_DOTS),
	};
}

/**
 * Reads a 2D symbol's module grid from bwip-js.
 *
 * @param bcid bwip-js's symbology identifier
 * @param text the content to encode
 * @param extra extra bwip-js options, e.g. `eclevel` for PDF417
 * @returns the symbol's width and height in modules
 * @throws Error if bwip-js reports this symbology's shape in the linear (bar-width) vocabulary
 *         instead, which would mean this function was called for the wrong kind of symbol
 */
function moduleGrid(bcid: string, text: string, extra?: Record<string, unknown>): { pixx: number; pixy: number } {
	const symbol = bwip.raw({ bcid, text, ...extra })[0];
	if (!("pixx" in symbol) || !("pixy" in symbol)) {
		throw new Error(`bwip-js did not return a module matrix for '${bcid}'`);
	}
	return { pixx: symbol.pixx, pixy: symbol.pixy };
}

/**
 * Reads a linear barcode's total width, in narrow-bar modules.
 *
 * bwip-js describes a 1D symbol as a sequence of alternating bar/space widths (`sbs`), which
 * sum to the symbol's width. There is no module matrix to read a height from — see the module
 * doc comment for why that is not a gap.
 *
 * @param bcid bwip-js's symbology identifier
 * @param text the content to encode
 * @returns the symbol's width in modules
 * @throws Error if bwip-js reports this symbology's shape as a module matrix instead
 */
function barModuleWidth(bcid: string, text: string): number {
	const symbol = bwip.raw({ bcid, text })[0];
	if (!("sbs" in symbol)) {
		throw new Error(`bwip-js did not return bar widths for '${bcid}'`);
	}
	return symbol.sbs.reduce((total, width) => total + width, 0);
}

/** Basic Code 39 / Code 93 alphabet: digits, uppercase letters, space, and `-.$/+%`. */
const CODE_39_93_PATTERN = /^[0-9A-Z \-.$/+%]+$/;

/**
 * One content rule per barcode symbology.
 *
 * Format-level only — length and alphabet, the mistakes a caller can fix by looking at the
 * string. Not check-digit arithmetic: content that passes here can still be rejected by the
 * encoder inside {@link symbolGeometry} if, say, an explicit check digit is wrong. That failure
 * belongs to the encoder to report, not to this function to predict.
 */
const BARCODE_CONTENT_RULES: Record<BarcodeSystem, (content: string) => string | null> = {
	UPCA: (content) => (/^\d{12}$/.test(content) ? null : "UPCA requires exactly 12 digits"),
	UPCE: (content) => (/^\d{7,8}$/.test(content) ? null : "UPCE requires 7 or 8 digits"),
	EAN13: (content) => (/^\d{13}$/.test(content) ? null : "EAN13 requires exactly 13 digits"),
	EAN8: (content) => (/^\d{8}$/.test(content) ? null : "EAN8 requires exactly 8 digits"),
	CODE39: (content) =>
		CODE_39_93_PATTERN.test(content)
			? null
			: "CODE39 accepts only digits, uppercase letters, spaces and the symbols -.$/+%",
	ITF: (content) => (/^\d+$/.test(content) ? null : "ITF (interleaved 2 of 5) accepts only digits"),
	CODABAR: (content) =>
		/^[A-D][0-9\-$:./+]*[A-D]$/.test(content)
			? null
			: "CODABAR must start and end with A, B, C or D, with digits and the symbols -$:./+ between them",
	CODE93: (content) =>
		CODE_39_93_PATTERN.test(content)
			? null
			: "CODE93 accepts only digits, uppercase letters, spaces and the symbols -.$/+%",
	CODE128: (content) => (content.length > 0 ? null : "CODE128 requires non-empty content"),
};

/**
 * The reason a symbology refuses this content, if any.
 *
 * @param spec what to print
 * @returns the reason the content is refused, or null when it is accepted
 */
export function validateSymbolContent(spec: SymbolSpec): string | null {
	switch (spec.kind) {
		case "QR":
			return spec.content.length > 0 ? null : "QR code content must not be empty";
		case "PDF417":
			return spec.content.length > 0 ? null : "PDF417 content must not be empty";
		case "BARCODE":
			return BARCODE_CONTENT_RULES[spec.system](spec.content);
	}
}
