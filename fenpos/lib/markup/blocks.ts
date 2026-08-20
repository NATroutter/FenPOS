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
 * Drawing lives here too, for the same reason. {@link symbolSvg} renders the symbol the paper
 * preview shows, from the same {@link encodeOptions} call that measured it, so the symbology, the
 * error level and the content the preview draws cannot be a different symbol from the one the
 * budget was charged for. It also keeps `bwip-js` out of the browser: the library statically pulls
 * in every symbology it supports, some two megabytes of encoders, which would otherwise land in the
 * panel's bundle to draw one QR code.
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

/**
 * The encoder's refusal of a symbol's content.
 *
 * Distinct from any other failure inside this module on purpose. {@link validateSymbolContent}
 * checks format only, so content that passes it can still be rejected by the encoder itself —
 * a wrong check digit is the usual case. That is a caller's mistake and belongs in a `400`,
 * whereas a bug in this module or a broken `bwip-js` install is a server fault and must stay a
 * `5xx`. Callers cannot tell those apart from a bare `Error`, so this type does it for them.
 */
export class SymbolEncodeError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SymbolEncodeError";
	}
}

/**
 * The identifier bwip-js stamps on a refusal, e.g. `bwipp.ean13badCheckDigit#6915: `.
 *
 * Matching it is how a refusal of the content is told apart from any other throw out of the
 * library. Stripping it is how a library-internal token — which moves with every bwip-js
 * release — stays out of a message an API caller reads.
 */
const BWIPP_REFUSAL = /^bwipp\.\w+#\d+:\s*/;

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
 * @throws SymbolEncodeError if the encoder refuses this content, e.g. a wrong check digit
 */
export function symbolGeometry(spec: SymbolSpec): SymbolGeometry {
	switch (spec.kind) {
		case "QR": {
			const grid = moduleGrid(spec);
			return toGeometry(grid.pixx * spec.size, grid.pixy * spec.size);
		}
		case "PDF417": {
			const grid = moduleGrid(spec);
			return toGeometry(grid.pixx * PDF417_MODULE_DOTS, grid.pixy * PDF417_MODULE_DOTS);
		}
		case "BARCODE": {
			const widthModules = barModuleWidth(spec);
			return toGeometry(widthModules * BARCODE_MODULE_WIDTH_DOTS, BARCODE_HEIGHT_DOTS);
		}
	}
}

/**
 * bwip-js 4.11.3 writes its fill rule as `fill=rule="evenodd"`.
 *
 * That is the library's own typo, and it is fatal rather than cosmetic: the panel draws the symbol
 * in an `<img>`, where an SVG is parsed as XML and an unquoted attribute value ends the parse, so
 * the symbol would not appear at all. Repaired on the way out rather than by rendering the markup
 * inline, which would trade a parse error for an injection surface. A release that fixes the typo
 * makes this a no-op.
 */
const BWIPP_FILL_RULE = /fill=rule=/g;

/**
 * Draws a symbol, as an SVG so it stays crisp at any zoom.
 *
 * The same {@link encodeOptions} call {@link symbolGeometry} measures, so the symbol drawn is the
 * symbol charged. Human-readable text is never drawn beside a barcode: the printer does not print
 * it, and a preview showing it would be showing something that will not be on the paper.
 *
 * @param spec what to print
 * @returns the symbol as an SVG document
 * @throws SymbolEncodeError if the encoder refuses this content, e.g. a wrong check digit
 */
export function symbolSvg(spec: SymbolSpec): string {
	return encoded(() => bwip.toSVG(encodeOptions(spec))).replace(BWIPP_FILL_RULE, "fill-rule=");
}

/**
 * One call to bwip-js: which symbology, with what content, encoded how.
 *
 * The single place a {@link SymbolSpec} becomes something the library understands. Measuring and
 * drawing both go through it, because a symbol measured as one symbology and drawn as another
 * would be a preview of a receipt nobody is going to print.
 *
 * `eclevel` is absent from the library's own `RenderOptions` although the encoder reads it, so the
 * option type is widened here rather than the value being smuggled past the type by a spread.
 *
 * @param spec what to print
 * @returns the options bwip-js takes for it
 */
function encodeOptions(spec: SymbolSpec): Parameters<typeof bwip.toSVG>[0] & { eclevel?: number } {
	switch (spec.kind) {
		case "QR":
			return { bcid: "qrcode", text: spec.content };
		case "BARCODE":
			return { bcid: BARCODE_BCID[spec.system], text: spec.content, includetext: false };
		case "PDF417":
			return { bcid: "pdf417", text: spec.content, eclevel: spec.errorLevel };
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
 * Runs a bwip-js call, naming a refusal of the content as such.
 *
 * The whole of this module's contact with bwip-js goes through here, so that the one place that
 * knows the library's error format is the one place that has to change when that format does.
 * Only a refusal is converted: anything else out of the library is a fault in this module or in
 * the install, and rethrowing it untouched is what keeps it visible as one.
 *
 * @param call the bwip-js call to make
 * @returns whatever the call returned
 * @throws SymbolEncodeError if bwip-js refuses the content, with its identifier prefix removed
 */
function encoded<T>(call: () => T): T {
	try {
		return call();
	} catch (thrown) {
		if (!(thrown instanceof Error) || !BWIPP_REFUSAL.test(thrown.message)) {
			throw thrown;
		}
		throw new SymbolEncodeError(thrown.message.replace(BWIPP_REFUSAL, ""), { cause: thrown });
	}
}

/** Describes a symbol with bwip-js, without drawing it. */
function rawSymbol(spec: SymbolSpec) {
	return encoded(() => bwip.raw(encodeOptions(spec))[0]);
}

/**
 * Reads a 2D symbol's module grid from bwip-js.
 *
 * @param spec the symbol to measure
 * @returns the symbol's width and height in modules
 * @throws Error if bwip-js reports this symbology's shape in the linear (bar-width) vocabulary
 *         instead, which would mean this function was called for the wrong kind of symbol
 */
function moduleGrid(spec: SymbolSpec): { pixx: number; pixy: number } {
	const symbol = rawSymbol(spec);
	if (!("pixx" in symbol) || !("pixy" in symbol)) {
		throw new Error(`bwip-js did not return a module matrix for a ${spec.kind} symbol`);
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
 * @param spec the barcode to measure
 * @returns the symbol's width in modules
 * @throws Error if bwip-js reports this symbology's shape as a module matrix instead
 */
function barModuleWidth(spec: SymbolSpec): number {
	const symbol = rawSymbol(spec);
	if (!("sbs" in symbol)) {
		throw new Error(`bwip-js did not return bar widths for a ${spec.kind} symbol`);
	}
	return symbol.sbs.reduce((total, width) => total + width, 0);
}

/** Basic Code 39 / Code 93 alphabet: digits, uppercase letters, space, and `-.$/+%`. */
const CODE_39_93_PATTERN = /^[0-9A-Z \-.$/+%]+$/;

/**
 * The UPC-E forms both encoders accept.
 *
 * Two encoders have to agree about a symbol: bwip-js measures it here, and escpos-coffee prints
 * it on the agent. For UPC-E they do not accept the same strings, so the rule is their overlap —
 * seven or eight digits led by number system 0.
 *
 *  - `1234567` — bwip-js measures it; escpos-coffee refuses it, because a UPC-E longer than six
 *    digits must carry the number system. Accepting it gives the caller a preview of a receipt
 *    that then fails to print.
 *  - `123456` and the eleven-to-twelve digit forms — escpos-coffee accepts them; bwip-js refuses
 *    them, so they would fail while being measured instead, which is a compile error that names
 *    the encoder rather than the rule the caller broke.
 *
 * Either way the caller is better served by hearing the actual constraint here.
 */
const UPCE_PATTERN = /^0\d{6,7}$/;

/** Highest code point a symbol's content may contain. */
const SYMBOL_MAX_CODE_POINT = 0x7f;

/**
 * Whether a symbol can carry this content.
 *
 * ASCII only, and that is a limit of the agent rather than of the symbologies, which encode
 * arbitrary bytes perfectly well. Two unrelated mechanisms in escpos-coffee land on the same
 * bound, and the consequence of exceeding it differs enough to be worth naming both:
 *
 *  - QR and PDF417 are written with `GS ( k`, whose store-data command the library builds with a
 *    length counted in characters while writing the string's UTF-8 bytes. One character above
 *    U+007F makes the declared length short, and the printer reads a truncated payload as a valid
 *    symbol. The failure mode is a symbol that scans and is wrong.
 *  - Code 128 is written with `GS k`, whose data the library checks against
 *    `^\{[A-C][\x00-\x7F]+$` before sending. A character above U+007F fails that match and it
 *    throws — after the job has been acknowledged, since nothing else on this side would have
 *    stopped it. `bwip-js` measures such content happily, so without this check the server hands
 *    back a `202` for a job the agent cannot print.
 *
 * Both are refused at compile time here so the caller gets a position instead of paper, or in the
 * Code 128 case instead of an accepted job that fails behind a printer.
 *
 * Written as a scan rather than a character-class regex because the range is expressed in code
 * points, and spelling it into a pattern means embedding control characters in source.
 *
 * @param content the symbol's payload
 * @returns whether every character is within ASCII
 */
function isSymbolAscii(content: string): boolean {
	for (const character of content) {
		if ((character.codePointAt(0) ?? 0) > SYMBOL_MAX_CODE_POINT) {
			return false;
		}
	}
	return true;
}

/**
 * One content rule per barcode symbology.
 *
 * Format-level only — length and alphabet, the mistakes a caller can fix by looking at the
 * string. Not check-digit arithmetic: content that passes here can still be rejected by the
 * encoder inside {@link symbolGeometry} if, say, an explicit check digit is wrong. That failure
 * belongs to the encoder to report, not to this function to predict.
 *
 * Where a rule looks stricter than the symbology's textbook definition, it is matching what the
 * agent's encoder will actually accept. A rule looser than that turns validation the caller gets
 * synchronously into a job that fails after being acknowledged.
 */
const BARCODE_CONTENT_RULES: Record<BarcodeSystem, (content: string) => string | null> = {
	UPCA: (content) => (/^\d{12}$/.test(content) ? null : "UPCA requires exactly 12 digits"),
	UPCE: (content) =>
		UPCE_PATTERN.test(content) ? null : "UPCE requires 7 or 8 digits beginning with 0, the number system",
	EAN13: (content) => (/^\d{13}$/.test(content) ? null : "EAN13 requires exactly 13 digits"),
	EAN8: (content) => (/^\d{8}$/.test(content) ? null : "EAN8 requires exactly 8 digits"),
	CODE39: (content) =>
		CODE_39_93_PATTERN.test(content)
			? null
			: "CODE39 accepts only digits, uppercase letters, spaces and the symbols -.$/+%",
	ITF: (content) =>
		/^(\d{2})+$/.test(content)
			? null
			: "ITF (interleaved 2 of 5) accepts an even number of digits, because it encodes them in pairs",
	CODABAR: (content) =>
		/^[A-D][0-9\-$:./+]*[A-D]$/.test(content)
			? null
			: "CODABAR must start and end with A, B, C or D, with digits and the symbols -$:./+ between them",
	CODE93: (content) =>
		CODE_39_93_PATTERN.test(content)
			? null
			: "CODE93 accepts only digits, uppercase letters, spaces and the symbols -.$/+%",
	// The one symbology here with no alphabet of its own — Code 128 covers the printable ASCII
	// range and the agent escapes the content rather than interpreting it — so ASCII is the whole
	// rule beyond being non-empty. See {@link isSymbolAscii} for what the agent does with anything wider.
	CODE128: (content) => {
		if (content.length === 0) {
			return "CODE128 requires non-empty content";
		}
		return isSymbolAscii(content)
			? null
			: "CODE128 content must be ASCII; the agent's Code 128 command carries one byte per character and refuses anything above U+007F";
	},
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
			return twoDimensionalContentError("QR code", spec.content);
		case "PDF417":
			return twoDimensionalContentError("PDF417", spec.content);
		case "BARCODE":
			return BARCODE_CONTENT_RULES[spec.system](spec.content);
	}
}

/**
 * The reason a two-dimensional symbol refuses this content, if any.
 *
 * Shared by QR and PDF417 because both are refused for the same two reasons and by the same
 * mechanism — see {@link isSymbolAscii} for why the ASCII bound exists at all.
 *
 * @param kind the symbol's name, as it should read in the message
 * @param content the symbol's payload
 * @returns the reason the content is refused, or null when it is accepted
 */
function twoDimensionalContentError(kind: string, content: string): string | null {
	if (content.length === 0) {
		return `${kind} content must not be empty`;
	}
	return isSymbolAscii(content)
		? null
		: `${kind} content must be ASCII; the agent declares the symbol's length in characters but sends it as UTF-8 bytes, so anything else prints as a symbol that scans wrongly`;
}
