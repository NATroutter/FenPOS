"use client";

import { DitheredImage } from "@/components/panel/dithered-image";

/**
 * An `<image>` as it will come out of the printer.
 *
 * **Nothing is dithered or measured here.** The PNG is the finished 1-bit raster — for a stored
 * image at the paper's own width, the very raster the agent was sent — rendered server-side by
 * `lib/assets/preview.ts` and sized by `lib/markup/images.ts`, the module the compiler charged the
 * line budget with. Deciding any of that in the browser would be a second answer to a question the
 * print path has already answered, and the two would disagree the first time either side changed.
 *
 * Same division of labour as `SymbolPreview` beside it, and for the same reason: this component's
 * whole job is to place a finished image on the paper at the size the paper says.
 */

/**
 * One image, drawn the size it will print.
 *
 * **Each side is measured in the unit the paper measures that side in.** The sheet is a grid of
 * characters whose two dot scales do not agree — a column is 12 dots wide and a line is 24 dots
 * tall, and on screen a character is not half as wide as a line is tall — so the width is the
 * image's share of the paper's *printable width*, which is what answers "does this fit across my 32
 * columns", and the height is the lines its dots really cover. Taking both from one scale is what
 * drew symbols half again too wide before `SymbolPreview` was made to stop doing it.
 *
 * The block around it is as tall as the lines the budget charged, which is a whole line more than
 * the dots cover whenever the two do not divide. That leftover is real: it is paper the receipt
 * paid for and the image does not ink.
 *
 * The picture is therefore drawn to both figures rather than fitted inside them. It is stretched by
 * whatever the two scales differ by — the same stretch every line of text on this sheet already
 * has — because an image's job on a receipt is to occupy the paper it occupies, and a scanner is
 * not going to read it.
 */
export function ImagePreview({
	reference,
	png,
	heightLines,
	inkedLines,
	widthFraction,
	lineHeightPx,
}: {
	/**
	 * What the tag named: a stored image, or a URL.
	 *
	 * Not called `ref`, which it is on the wire: React treats a prop of that name as a ref rather
	 * than as a value, so a string arriving under it would never reach this function.
	 */
	reference: string;
	/** The dithered raster, as a data URI. */
	png: string;
	/** Printed lines this image occupies, as the compiler charged it against the line budget. */
	heightLines: number;
	/** Lines its dots really cover, before the budget rounded them up to a whole one. */
	inkedLines: number;
	/** Its printed width as a share of the paper's own, where 1 is the full sheet. */
	widthFraction: number;
	/** The preview's own line height, so the image occupies the rows it was charged. */
	lineHeightPx: number;
}) {
	return (
		// `lineHeight: 0` because the image is inline and would otherwise sit on a text baseline,
		// leaving a descender's worth of paper under it that nothing prints on.
		<div style={{ height: `${heightLines * lineHeightPx}px`, lineHeight: 0 }}>
			{/* `display` is set rather than left alone: Tailwind's preflight makes every image a
			    block, and a block ignores the line's alignment and sits hard against the left of the
			    paper however the element was aligned. Inline is what lets a centred logo be centred
			    by the same rule that centres a centred line of text. */}
			<DitheredImage
				src={png}
				alt={`${reference}, dithered as it will print`}
				style={{
					display: "inline-block",
					// Clamped for the same reason a symbol's is, though nothing can currently reach
					// it: the tag's argument is a percentage of the paper and stops at 100.
					width: `${Math.min(widthFraction, 1) * 100}%`,
					height: `${inkedLines * lineHeightPx}px`,
					verticalAlign: "top",
				}}
			/>
		</div>
	);
}
