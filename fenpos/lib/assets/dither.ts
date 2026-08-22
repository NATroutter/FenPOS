import { Jimp, JimpMime } from "jimp";
import { IMAGE_LIMITS } from "@/lib/link/protocol";

/**
 * Turning an uploaded image into something an ESC/POS printer can put on paper.
 *
 * A thermal head has one ink and no greys: every dot is burned or it is not. Getting a
 * photograph or a logo onto that head means choosing, for each dot, black or white, and
 * spreading the difference between the colour that was wanted and the colour that was printed
 * across the neighbours that have not been decided yet. That is {@link ditherToRaster}.
 *
 * **The source image is stored; the raster is derived.** A raster dithered for 80mm paper is 504
 * dots wide. Printing it on a 58mm device means downscaling pixels that have already been
 * reduced to black and white, which resamples the dither noise itself and turns a picture into
 * mud. One install can have both widths behind a single agent, so there is no single correct
 * width to dither at.
 *
 * So callers store the uploaded bytes and derive a raster from them per paper width, keeping the
 * result against that width: once on upload, and once more the first time a new width is asked
 * for. What callers must not do is call this from the print path. Dithering half a megapixel is
 * real work, and the print path is the one place in this system that cannot afford to do it.
 *
 * The panel's paper preview calls {@link ditherToRaster} with the same width the device will use,
 * so what is on screen is what comes off the printer, speckle for speckle.
 *
 * Widths come from `dotWidth(columns)` in `lib/markup/blocks.ts`, the same conversion the rest of
 * the markup pipeline measures with, so an image and the text beside it agree about how wide the
 * paper is.
 */

/**
 * An uploaded file that is not an image this pipeline will print.
 *
 * Distinct from any other failure in this module, and for the same reason `SymbolEncodeError` is:
 * a caller's bad upload belongs in a `400`, while a broken `jimp` install or a bug here is a
 * server fault and must stay a `5xx`. A bare `Error` cannot be told apart from either.
 *
 * It covers two refusals that look different to the user but are the same decision — bytes that
 * will not decode at all, and bytes that decode into a format outside {@link ACCEPTED_MIME_TYPES}.
 */
export class ImageDecodeError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ImageDecodeError";
	}
}

/**
 * The image formats an asset may be uploaded in.
 *
 * `jimp` decodes more than this — GIF, BMP and TIFF all come back as usable bitmaps — so the set
 * is stated rather than inherited. This is the same class of disagreement the symbol tags hit
 * between `bwip-js` and `escpos-coffee`: what a library will accept is not the same question as
 * what the product should accept. PNG and JPEG cover every real receipt logo, they are the two
 * formats a browser's file picker and a phone camera produce, and narrowing the set here keeps
 * animation and colour-profile handling out of the pipeline entirely.
 */
const ACCEPTED_MIME_TYPES: readonly string[] = [JimpMime.png, JimpMime.jpeg];

/** The values `assets.acceptedFormats` may hold, mirroring that setting's declared `values`. */
export type AcceptedFormatsSetting = "png+jpeg" | "png";

/**
 * Which MIME types each `assets.acceptedFormats` value admits.
 *
 * `"png+jpeg"` is exactly {@link ACCEPTED_MIME_TYPES} — this pipeline's own baseline, restated as a
 * lookup rather than reformulated — and `"png"` narrows it to the one format that never touches the
 * expensive JPEG decoder. Read by `asset-service.ts`'s `measured()`, which is the gate every new
 * upload or import passes; {@link ditherToRaster} takes the full baseline instead of this lookup,
 * because it re-renders bytes that were already accepted at intake — narrowing the setting
 * afterwards must not stop an existing image from printing.
 */
export const FORMAT_MIME_TYPES: Record<AcceptedFormatsSetting, readonly string[]> = {
	"png+jpeg": ACCEPTED_MIME_TYPES,
	png: [JimpMime.png],
};

/**
 * Names the accepted formats the way a person reads them, for a refusal message.
 *
 * @param mimeTypes the MIME types currently accepted, in the order they should be named
 * @returns e.g. "PNG or JPEG", or "PNG" when JPEG is not among them
 */
function formatsLabel(mimeTypes: readonly string[]): string {
	return mimeTypes.map((mime) => (mime === JimpMime.jpeg ? "JPEG" : "PNG")).join(" or ");
}

/**
 * The pixel ceiling handed to the JPEG decoder, in megapixels.
 *
 * Mirrors `MAX_IMAGE_DIMENSION` in `asset-service.ts`: 4096 on a side is 16.78 MP, so 17 is the
 * smallest whole number that admits everything the asset store admits and nothing beyond it. It is
 * restated here rather than imported because `asset-service.ts` imports *this* module, and the
 * asset tests assert the two stay in step so the duplication cannot drift silently.
 *
 * This is a genuine pre-allocation gate: `jpeg-js` checks it while reading the frame header, before
 * `prepareComponents` allocates anything (`decoder.js:736` precedes `decoder.js:603`).
 */
export const MAX_JPEG_MEGAPIXELS = 17;

/**
 * The memory budget handed to the JPEG decoder, in megabytes.
 *
 * `jpeg-js` defaults to 512 MB and that default is what a receipt logo does not need. Worse, the
 * budget is charged optimistically: a coefficient block is billed at `blocksToAllocate * 256`
 * (`decoder.js:603`) — 256 bytes for an `Int32Array(64)` — which ignores V8's per-object overhead
 * on every one of those arrays, so real resident memory runs about 2.5x the number being counted.
 *
 * That gap is reachable from a file that is otherwise entirely within bounds. A frame header alone
 * allocates: 21 bytes declaring 4096x4096 with three components cost +497 MB, and 777 bytes
 * declaring the same size with 255 components cost +1286 MB, both measured through this module's
 * own `Jimp.fromBuffer` call and both well inside the asset store's 2 MB byte cap and 4096 pixel
 * cap. No scan data is needed; the allocation happens while parsing the header.
 *
 * 384 is the smallest round budget that still decodes a real 4:4:4 JPEG at the full permitted
 * 4096x4096, which measurement puts at just over 353 MB of charged allocation. It takes the
 * 255-component case from +1286 MB down to +969 MB.
 *
 * What it deliberately does not do is reduce the ~500 MB that a three-component 4096x4096 frame
 * costs, because that is exactly what a *legitimate* 4:4:4 image at the permitted dimensions
 * allocates — the two are indistinguishable by memory accounting, and the cost is a property of the
 * dimension cap rather than a defect here. Lowering it means lowering `MAX_IMAGE_DIMENSION`, which
 * is a product decision and not this module's to make.
 */
export const MAX_JPEG_DECODE_MB = 384;

/**
 * Decoder limits, keyed by MIME type the way jimp forwards them.
 *
 * `@jimp/core` passes `options[format.mime]` straight into the format's decoder, so this is how a
 * bound reaches `jpeg-js` at all. PNG has no equivalent entry because `pngjs` takes no options;
 * it is bounded instead by refusing interlacing, which keeps every PNG on the branch that sizes its
 * inflate from the declared dimensions. See `requireDecodableSize` in `asset-service.ts`.
 */
const DECODE_LIMITS = {
	[JimpMime.jpeg]: {
		maxMemoryUsageInMB: MAX_JPEG_DECODE_MB,
		maxResolutionInMP: MAX_JPEG_MEGAPIXELS,
	},
};

/** What an uploaded image turned out to be. */
export interface DecodedImage {
	width: number;
	height: number;
	/** The format actually decoded, not the one the upload claimed. */
	mimeType: string;
}

/**
 * How tall a source of these proportions comes out once resized to a paper width.
 *
 * **The bound every other image limit misses.** The byte cap, the 4096-per-side cap, the Adam7
 * refusal and the JPEG decode budget all bound the *input*; none of them bounds the *aspect ratio*,
 * and the raster's height is the input's aspect ratio multiplied by the paper width. A 4x1024 PNG
 * is 1,106 bytes, passes every one of those checks, and projects to 384x98,304 — 4.7 MB of packed
 * dots and, measured through `ditherToRaster` on this machine, +439 MB resident. A 1x4096 source
 * projects to ~7 GB. So the derived size has to be predicted from the two numbers in the header and
 * refused before anything is allocated, which is what this exists for.
 *
 * `Math.round` mirrors what jimp's own `resize({ w })` does to the omitted height, so the prediction
 * is the size that would really have been produced rather than an estimate of it.
 *
 * @param width the source's width in pixels
 * @param height the source's height in pixels
 * @param targetDots the paper width in printer dots
 * @returns the height in dots the derived raster would have
 */
export function projectedHeightDots(width: number, height: number, targetDots: number): number {
	return Math.round((height * targetDots) / width);
}

/** An image reduced to one bit per dot, ready for an ESC/POS raster command. */
export interface ImageRaster {
	widthDots: number;
	heightDots: number;
	/** One bit per dot, MSB first, each row padded to a whole number of bytes. A set bit is ink. */
	packed: Buffer;
}

/**
 * The luminance at or above which a dot is left as paper.
 *
 * Mid-grey. Error diffusion pushes values well outside 0–255 as it accumulates, which is normal
 * and is why the comparison is against the running value rather than the original pixel.
 */
const INK_THRESHOLD = 128;

/** Rec. 709 luminance weights, the same ones jimp's own `greyscale` uses. */
const LUMA_RED = 0.2126;
const LUMA_GREEN = 0.7152;
const LUMA_BLUE = 0.0722;

/** Bytes per pixel in jimp's bitmap: R, G, B, A. */
const CHANNELS = 4;

/**
 * Reads an uploaded image's dimensions and format.
 *
 * Decoding is the validation. A file that will not decode, or decodes into a format this pipeline
 * does not print, is refused here — at upload, where the user is still looking at the file picker
 * — rather than at print time behind a printer where nobody can act on it.
 *
 * @param bytes the uploaded file
 * @param acceptedFormats which MIME types to accept; defaults to {@link ACCEPTED_MIME_TYPES}, this
 *        pipeline's full baseline. `asset-service.ts`'s `measured()` — the gate every new upload or
 *        import passes — narrows this to the configured `assets.acceptedFormats`.
 * @returns the image's pixel dimensions and its actual format
 * @throws ImageDecodeError if the bytes will not decode, or decode to a format not in `acceptedFormats`
 */
export async function decodeImage(
	bytes: Buffer,
	acceptedFormats: readonly string[] = ACCEPTED_MIME_TYPES,
): Promise<DecodedImage> {
	const { image, mimeType } = await accepted(bytes, acceptedFormats);
	return { width: image.bitmap.width, height: image.bitmap.height, mimeType };
}

/**
 * Renders an image as a 1-bit raster of a given width.
 *
 * Resized to `targetDots` preserving aspect, flattened onto white, then Floyd–Steinberg dithered:
 * each dot is decided black or white, and the error — how far the decision fell from the tone that
 * was wanted — is handed to the neighbours still undecided, 7/16 to the right, then 3/16, 5/16 and
 * 1/16 to the row below. Spreading the error is what makes a gradient read as a gradient instead
 * of two flat bands.
 *
 * Runs on upload and once per distinct paper width. Never on the print path — see the module
 * comment for why.
 *
 * **A source too tall for its width is refused before the resize, not after.** See
 * {@link projectedHeightDots}: the resize is the allocation this module cannot afford to make
 * blind, and `IMAGE_LIMITS.maxHeightDots` was previously only consulted once the dots already
 * existed. Callers that can refuse earlier should — `measured` in `asset-service.ts` does, against
 * the widest paper an install can configure, so a source like this never reaches the store — but
 * this check is the one that cannot be walked around, and it is what protects rows stored before
 * that gate existed.
 *
 * @param bytes the uploaded file
 * @param targetDots the paper width in printer dots, from `dotWidth(columns)`
 * @returns the raster's size in dots and its packed bits, MSB first
 * @throws ImageDecodeError if the bytes are not a PNG or a JPEG, or are so tall for their width
 *         that the raster would exceed `IMAGE_LIMITS.maxHeightDots`
 * @throws RangeError if `targetDots` is not a positive whole number of dots
 */
export async function ditherToRaster(bytes: Buffer, targetDots: number): Promise<ImageRaster> {
	if (!Number.isInteger(targetDots) || targetDots <= 0) {
		throw new RangeError(`A raster width must be a positive whole number of dots, not ${targetDots}`);
	}

	// The full baseline, not the configured `assets.acceptedFormats` — see FORMAT_MIME_TYPES's doc
	// comment. These bytes already passed `measured()` at intake; narrowing the setting afterwards
	// must not stop an existing image from being re-dithered for a new paper width.
	const { image } = await accepted(bytes, ACCEPTED_MIME_TYPES);
	const projected = projectedHeightDots(image.bitmap.width, image.bitmap.height, targetDots);
	if (projected > IMAGE_LIMITS.maxHeightDots) {
		throw new ImageDecodeError(
			`This image is ${image.bitmap.width}x${image.bitmap.height}, which at ${targetDots} dots wide would print ${projected} dots tall — more than the ${IMAGE_LIMITS.maxHeightDots} a raster can be. Crop it, or print it at a narrower width.`,
		);
	}

	flattenOntoWhite(image.bitmap.data);
	// jimp 1.x takes an options object; omitting `h` is what keeps the aspect ratio.
	image.resize({ w: targetDots });

	const { width, height, data } = image.bitmap;
	return { widthDots: width, heightDots: height, packed: floydSteinberg(luminance(data), width, height) };
}

/**
 * Decodes bytes into an image this pipeline will print.
 *
 * The single point of contact with jimp's decoder, so that the one place that knows how the
 * library reports a bad file is the one place that changes when it does.
 *
 * jimp declares an image's `mime` as optional, so a decode that produced pixels but no format is
 * possible as far as the types are concerned. It is treated as a file that did not decode: an
 * image this pipeline cannot name is an image it cannot promise to print.
 *
 * @param bytes the uploaded file
 * @param acceptedFormats which MIME types to accept
 * @returns the decoded image and the format it actually is
 * @throws ImageDecodeError if the bytes will not decode, or decode to a format not in `acceptedFormats`
 */
async function accepted(
	bytes: Buffer,
	acceptedFormats: readonly string[],
): Promise<{ image: Awaited<ReturnType<typeof Jimp.fromBuffer>>; mimeType: string }> {
	let image: Awaited<ReturnType<typeof Jimp.fromBuffer>>;
	try {
		image = await Jimp.fromBuffer(bytes, DECODE_LIMITS);
	} catch (thrown) {
		throw new ImageDecodeError("This file could not be read as an image.", { cause: thrown });
	}

	const mimeType = image.mime;
	if (mimeType === undefined) {
		throw new ImageDecodeError("This file could not be read as an image.");
	}
	if (!acceptedFormats.includes(mimeType)) {
		throw new ImageDecodeError(`Images must be ${formatsLabel(acceptedFormats)}; this one is ${mimeType}.`);
	}
	return { image, mimeType };
}

/**
 * Composites every pixel onto a white background, in place.
 *
 * Receipt logos are usually PNGs with a transparent background, and the colour hiding behind a
 * transparent pixel is very often black. Read as opaque colour it would print as a solid black
 * slab around the logo, so alpha has to mean paper.
 *
 * Done before the resize rather than after, so that every pixel the resampler averages already
 * means what it will print. Flattening afterwards would decide each output pixel's alpha from its
 * neighbours' and then composite that blend onto white, which is a different picture along every
 * soft edge than compositing first and resampling the opaque result — and only the second is the
 * one the operator saw in their editor. Doing it first also means the resize has no alpha channel
 * left to interpolate at all.
 *
 * @param data jimp's RGBA bitmap, modified in place
 */
function flattenOntoWhite(data: Buffer): void {
	for (let at = 0; at < data.length; at += CHANNELS) {
		const alpha = data[at + 3] / 255;
		if (alpha === 1) {
			continue;
		}
		const paper = 255 * (1 - alpha);
		data[at] = Math.round(data[at] * alpha + paper);
		data[at + 1] = Math.round(data[at + 1] * alpha + paper);
		data[at + 2] = Math.round(data[at + 2] * alpha + paper);
		data[at + 3] = 255;
	}
}

/**
 * Converts an opaque RGBA bitmap to greyscale.
 *
 * Held as floats rather than bytes because the dither adds fractional error to pixels it has not
 * reached yet, and rounding that back to a byte on every one of the four hand-offs would lose the
 * very quantity the algorithm exists to carry.
 *
 * @param data an RGBA bitmap that {@link flattenOntoWhite} has already made opaque
 * @returns one luminance per pixel, in row-major order
 */
function luminance(data: Buffer): Float64Array {
	const grey = new Float64Array(data.length / CHANNELS);
	for (let pixel = 0; pixel < grey.length; pixel++) {
		const at = pixel * CHANNELS;
		grey[pixel] = LUMA_RED * data[at] + LUMA_GREEN * data[at + 1] + LUMA_BLUE * data[at + 2];
	}
	return grey;
}

/**
 * Dithers greyscale luminances into packed 1-bit dots.
 *
 * Bits are packed most significant first — the leftmost dot of a row is bit 7 of its first byte —
 * which is the order ESC/POS raster commands read. Rows are padded to a whole number of bytes
 * because those commands count a row's width in bytes; the buffer is zero-filled, so the padding
 * is paper and never prints as a black tail.
 *
 * `grey` is written through as the scan proceeds: each pixel's error is added to neighbours that
 * have not been visited yet, so no pixel is ever revised after it has been decided.
 *
 * @param grey one luminance per pixel, row-major; consumed destructively
 * @param width the raster width in dots
 * @param height the raster height in dots
 * @returns the packed raster
 */
function floydSteinberg(grey: Float64Array, width: number, height: number): Buffer {
	const rowBytes = Math.ceil(width / 8);
	const packed = Buffer.alloc(rowBytes * height);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const here = y * width + x;
			const wanted = grey[here];
			const inked = wanted < INK_THRESHOLD;
			if (inked) {
				packed[y * rowBytes + (x >> 3)] |= 0x80 >> (x % 8);
			}

			const error = wanted - (inked ? 0 : 255);
			const hasRight = x + 1 < width;
			const hasBelow = y + 1 < height;
			if (hasRight) {
				grey[here + 1] += (error * 7) / 16;
			}
			if (hasBelow) {
				if (x > 0) {
					grey[here + width - 1] += (error * 3) / 16;
				}
				grey[here + width] += (error * 5) / 16;
				if (hasRight) {
					grey[here + width + 1] += error / 16;
				}
			}
		}
	}
	return packed;
}
