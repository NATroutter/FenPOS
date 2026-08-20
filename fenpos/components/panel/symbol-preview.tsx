"use client";

import bwip from "bwip-js/browser";
import type { BarcodeSystem } from "@/lib/domain/enums";
import type { SymbolSpec } from "@/lib/markup/blocks";

/**
 * A QR code, a barcode or a PDF417 as it will come out of the printer.
 *
 * One component over one encoder, because `bwip-js` covers all three. Three components over three
 * libraries would be three places for the preview to drift from the paper.
 *
 * The library is imported from its browser entry rather than through `lib/markup/blocks.ts`, which
 * is where the compiler measures these same symbols: that module imports the library's Node entry,
 * and reaching it from a client component would drag Node's build into the browser bundle. Nothing
 * is measured here either — `heightLines` arrives already charged against the job's line budget, so
 * the paper the budget paid for and the paper the preview draws are the same number rather than two
 * numbers that agree until they do not.
 */

/**
 * bwip-js's symbology identifier for each barcode system.
 *
 * The same table as `blocks.ts`'s, and it has to stay the same table: the compiler measures a
 * symbol through that one and this draws it through this one, so a symbol measured as CODE93 and
 * drawn as CODE39 would be a preview of a receipt nobody is going to print. It is duplicated rather
 * than imported because importing it would bring `bwip-js/node` with it — see the note above — so
 * it is exported for `symbol-preview.test.ts` to pin against the other one, which is what keeps a
 * duplicate from quietly becoming a difference.
 */
export const BARCODE_BCID: Record<BarcodeSystem, string> = {
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
 * One call to bwip-js.
 *
 * `eclevel` is absent from the library's own `RenderOptions` although the encoder reads it, so it
 * is added here instead of being smuggled past the type through a spread.
 */
type EncodeOptions = Parameters<typeof bwip.toSVG>[0] & { eclevel?: number };

/**
 * bwip-js 4.11.3 writes its fill rule as `fill=rule="evenodd"`.
 *
 * That is the library's own typo, and it matters here rather than being cosmetic: an SVG inside an
 * `<img>` is parsed as XML, where an unquoted attribute value is fatal, so the symbol would not
 * draw at all. Repaired on the way out rather than worked around by rendering the markup inline,
 * which would trade a parse error for an injection surface. A release that fixes the typo makes
 * this a no-op.
 */
const MALFORMED_FILL_RULE = /fill=rule=/g;

/**
 * Encodes one symbol as an SVG, so it stays crisp at any zoom.
 *
 * Text is never drawn beside a barcode: the printer does not print it, and a preview that showed it
 * would be showing something that will not be on the paper.
 *
 * @param spec the symbol to draw
 * @returns the SVG document, as markup
 * @throws Error if bwip-js refuses the content, which cannot happen for content the compiler has
 *         already measured — that measurement encodes it through this same library
 */
export function symbolSvg(spec: SymbolSpec): string {
	return bwip.toSVG(encodeOptions(spec)).replace(MALFORMED_FILL_RULE, "fill-rule=");
}

/**
 * The bwip-js call that draws one symbol.
 *
 * The QR's module size and the barcode's height are deliberately not passed: they are printed
 * dimensions, and this SVG is scaled to the height the symbol was charged rather than drawn at any
 * particular size of its own.
 *
 * @param spec the symbol to draw
 * @returns the options bwip-js takes for it
 */
function encodeOptions(spec: SymbolSpec): EncodeOptions {
	switch (spec.kind) {
		case "QR":
			return { bcid: "qrcode", text: spec.content };
		case "BARCODE":
			return { bcid: BARCODE_BCID[spec.system], text: spec.content, includetext: false };
		case "PDF417":
			return { bcid: "pdf417", text: spec.content, eclevel: spec.errorLevel };
	}
}

/**
 * Names a symbol for a reader who cannot see it.
 *
 * @param spec the symbol
 * @returns what it is and what it carries
 */
function describeSymbol(spec: SymbolSpec): string {
	switch (spec.kind) {
		case "QR":
			return `QR code: ${spec.content}`;
		case "BARCODE":
			return `${spec.system} barcode: ${spec.content}`;
		case "PDF417":
			return `PDF417 symbol: ${spec.content}`;
	}
}

/**
 * One symbol, drawn the size it will print.
 *
 * **The symbol occupies exactly the lines it was charged.** A receipt that will not fit therefore
 * still looks like one that will not fit, which is the entire reason the preview is drawn against
 * the compiler's own measurement instead of against whatever size looks good.
 *
 * Its width is the encoder's own proportion for that symbol rather than a second measurement: the
 * height is the number that was budgeted, and taking a second opinion on the width would reopen
 * exactly the gap between preview and paper that the shared measurement closes.
 */
export function SymbolPreview({
	spec,
	heightLines,
	lineHeightPx,
}: {
	spec: SymbolSpec;
	/** Printed lines this symbol occupies, as the compiler charged it against the line budget. */
	heightLines: number;
	/** The preview's own line height, so the symbol occupies the rows it was charged. */
	lineHeightPx: number;
}) {
	return (
		// `lineHeight: 0` because the symbol is an inline image and would otherwise sit on a text
		// baseline, leaving a descender's worth of paper under every symbol that nothing prints on.
		<div style={{ height: `${heightLines * lineHeightPx}px`, lineHeight: 0 }}>
			{/* `display` is set rather than left alone: Tailwind's preflight makes every image a
			    block, and a block ignores the line's alignment and sits hard against the left of
			    the paper however the element was aligned. Inline is what lets a centred QR be
			    centred by the same rule that centres a centred line of text.

			    `maxWidth` is the one place the drawn size gives way. Nothing refuses a symbol whose
			    content makes it wider than the paper — the geometry measures a width but no limit
			    is checked against it — and one drawn past the edge would push the sheet out from
			    under every line around it, which misdraws the whole receipt to make one symbol's
			    overflow visible. It shrinks to the paper's width instead, keeping its shape. */}
			{/** biome-ignore lint/performance/noImgElement: a data URI is already inlined; there is nothing for the image pipeline to optimise. */}
			<img
				src={`data:image/svg+xml,${encodeURIComponent(symbolSvg(spec))}`}
				alt={describeSymbol(spec)}
				style={{ display: "inline-block", height: "100%", width: "auto", maxWidth: "100%", verticalAlign: "top" }}
			/>
		</div>
	);
}
