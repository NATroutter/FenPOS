"use client";

import type { SymbolSpec } from "@/lib/markup/blocks";

/**
 * A QR code, a barcode or a PDF417 as it will come out of the printer.
 *
 * **Nothing is encoded or measured here.** The SVG and both of its dimensions are made server-side
 * by `lib/markup/blocks.ts`, the module the compiler charges the line budget with, so the symbol on
 * screen cannot be a different symbol — or a different size — from the one that was paid for. That
 * is also what keeps `bwip-js` out of this bundle: it statically carries every symbology it
 * supports, some two megabytes of encoders, to draw one QR code.
 *
 * This component's whole job is to place a finished image on the paper at the size the paper says.
 */

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
 * **Each side of the block is measured in the unit the paper measures that side in.** The sheet is a
 * grid of characters and its two dot scales do not agree: a column is 12 dots wide and a line is 24
 * dots tall, but on screen a character is not half as wide as a line is tall. So the block is as
 * tall as the lines the symbol was charged — a receipt that will not fit still looks like one that
 * will not fit — and as wide as the symbol's share of the paper's printable width, which is what
 * answers "does this fit across my 32 columns". Taking both from one scale would answer one of those
 * two questions wrongly.
 *
 * The symbol keeps its own proportions inside that block, because an SVG in an `<img>` fits itself
 * to its box rather than stretching to it: a square QR code stays square and stays unambiguous to a
 * scanner. What is left over inside the block is paper the symbol does not ink — partly the two
 * scales differing, partly the rounding up to a whole line that the budget charged for.
 */
export function SymbolPreview({
	spec,
	svg,
	heightLines,
	widthFraction,
	lineHeightPx,
}: {
	spec: SymbolSpec;
	/** The symbol, already drawn by the module that measured it. */
	svg: string;
	/** Printed lines this symbol occupies, as the compiler charged it against the line budget. */
	heightLines: number;
	/** Its printed width as a share of the paper's own, where 1 is the full sheet. */
	widthFraction: number;
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

			    A symbol wider than the paper is clamped to the sheet, because drawing it past the
			    edge would push the sheet out from under every line around it — which misdraws the
			    whole receipt to make one symbol's overflow visible. The overflow is said in words
			    instead, beside the symbol. */}
			{/** biome-ignore lint/performance/noImgElement: a data URI is already inlined; there is nothing for the image pipeline to optimise. */}
			<img
				src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
				alt={describeSymbol(spec)}
				style={{
					display: "inline-block",
					height: "100%",
					width: `${Math.min(widthFraction, 1) * 100}%`,
					verticalAlign: "top",
				}}
			/>
		</div>
	);
}
