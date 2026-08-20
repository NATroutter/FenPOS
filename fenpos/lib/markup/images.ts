import { dotWidth, LINE_HEIGHT_DOTS } from "@/lib/markup/blocks";

/**
 * How much paper an `<image>` costs, and what the compiler has to be told to work it out.
 *
 * This is the image counterpart of `blocks.ts`, and it exists for the same reason: the line budget
 * and the paper preview must charge and draw the same picture. What differs is where the input
 * comes from. A symbol's size follows from content the parser is already holding, so `blocks.ts`
 * measures it during the parse. An image's size follows from the image's *own* dimensions, which
 * live in a database row or behind an HTTP request — so measuring one is asynchronous, and
 * `parseMarkup` is not.
 *
 * That split is why an `IMAGE` directive carries no height. The dimensions are resolved once per
 * request, before compiling, by `resolve-images.ts`; the resulting {@link ResolvedImages} reaches
 * the compiler through `CompileSettings`, and {@link imageGeometry} is what turns one of those
 * entries into dots. Nothing here touches the database or the network, so the compile path stays
 * synchronous.
 */

/**
 * An image's own size in pixels, as uploaded or as fetched.
 *
 * Deliberately not the raster's size. A raster exists per paper width; this is the one thing about
 * an image that is the same on every printer, which is exactly why it is what gets resolved and
 * cached per request rather than per device.
 */
export interface ImageSource {
	width: number;
	height: number;
}

/**
 * Every image a request refers to, keyed by the reference exactly as it was written between the
 * tags — a stored asset's name, or a URL.
 *
 * Keyed by reference rather than by reference and width, because the source size does not depend on
 * the width it will be printed at. Two `<image>` tags naming the same asset at different
 * percentages are one lookup and one fetch.
 */
export type ResolvedImages = ReadonlyMap<string, ImageSource>;

/** The printed size of one image, in printer dots and in whole lines of paper. */
export interface ImageGeometry {
	widthDots: number;
	heightDots: number;
	/** {@link heightDots}, rounded up to a whole line, since paper only advances by whole lines. */
	heightLines: number;
}

/** A width percentage means a share of a hundred. */
const PERCENT = 100;

/**
 * Works out how large an image prints on a given device.
 *
 * **The rounding is not free choice.** `ditherToRaster` hands the width to jimp and lets jimp
 * decide the height, so the height charged here has to be the height jimp will produce or the
 * budget describes a different picture from the one that prints. Checked against jimp's own resize
 * in `images.test.ts`, including the case where the arithmetic wants a fraction of a dot row and
 * jimp keeps a whole one.
 *
 * @param source the image's own pixel dimensions
 * @param widthPercent the tag's argument: the share of the paper's width to print at, 1-100
 * @param columns the device's width in printer columns
 * @returns the printed size in dots, and what it costs the line budget
 * @throws RangeError if the source has no pixels, which would make the height meaningless
 */
export function imageGeometry(source: ImageSource, widthPercent: number, columns: number): ImageGeometry {
	if (source.width <= 0 || source.height <= 0) {
		throw new RangeError(`An image must have pixels to be printed, not ${source.width}x${source.height}`);
	}

	// At least one dot in each direction: an image scaled below a whole dot still prints, and
	// charging it nothing would let a job past the budget it was measured against.
	const widthDots = Math.max(1, Math.round((dotWidth(columns) * widthPercent) / PERCENT));
	const heightDots = Math.max(1, Math.round((source.height * widthDots) / source.width));

	return { widthDots, heightDots, heightLines: Math.ceil(heightDots / LINE_HEIGHT_DOTS) };
}
