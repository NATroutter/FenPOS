import "server-only";
import { type DecodedImage, decodeImage, ImageDecodeError } from "@/lib/assets/dither";
import { ApiError } from "@/lib/errors";
import { describeBytes } from "@/lib/format/bytes";

/**
 * The image-safety gate, shared by every caller that hands bytes to a decoder.
 *
 * Lifted out of `asset-service.ts`, where it grew, because the asset store is no longer the only
 * door bytes arrive through and a second copy of these defences would be a second thing to get
 * wrong. What is here is what protects the *decoder*; what stayed behind in `asset-service.ts` is
 * what protects the *printer* — `requireProjectedHeight`, which is a paper decision and means
 * nothing to a caller that is not printing.
 *
 * The caps are arguments rather than settings reads, so the module cannot apply one caller's bound
 * to another caller's bytes. See {@link ImageBounds}.
 */

/**
 * The bounds one caller puts on an image.
 *
 * Passed in rather than read from settings here, because the two callers answer to different
 * operators' intentions: the asset store's cap is `assets.maxUploadMb`, an install-wide choice about
 * receipt logos, while an avatar's is fixed and small. A module that read either would be a module
 * that could apply the wrong one.
 */
export interface ImageBounds {
	maxBytes: number;
	maxDimension: number;
	acceptedMimeTypes: readonly string[];
}

/** An image's own account of itself, read from its header rather than from a decoded bitmap. */
export interface DeclaredImage {
	width: number;
	height: number;
	/** Adam7. PNG only, and the one flag that makes the two dimensions above stop meaning anything. */
	interlaced: boolean;
}

/**
 * The one gate bytes pass before any caller believes them.
 *
 * The order is the load-bearing part: the size is read from the file's own header *before* the
 * decoder is handed the bytes, because the allocation being defended against happens inside the
 * decode. See {@link requireDecodableSize}.
 *
 * The byte cap is checked first, before the header is even looked at, so bytes that are simply too
 * many are refused as such rather than as an unreadable file — which is what a caller who picked a
 * 30 MB photograph needs to be told.
 *
 * @param bytes the image, as uploaded or as fetched
 * @param bounds this caller's caps
 * @returns what the bytes turned out to be
 * @throws ApiError if they are too large, too big in pixels, or not an accepted format
 */
export async function measureImage(bytes: Buffer, bounds: ImageBounds): Promise<DecodedImage> {
	requireWithinBytes(bytes.length, bounds.maxBytes);
	requireDecodableSize(bytes, bounds.maxDimension);

	let decoded: DecodedImage;
	try {
		decoded = await decodeImage(bytes, bounds.acceptedMimeTypes);
	} catch (thrown) {
		if (thrown instanceof ImageDecodeError) {
			// The decoder's message is already written for whoever chose the file. Re-raised as an
			// ApiError so the panel shows it, instead of the action's catch-all turning a bad
			// upload into "something went wrong, check the server log".
			throw new ApiError("invalid_image", thrown.message, {}, { cause: thrown });
		}
		throw thrown;
	}

	// Belt and braces: the header said one thing, the decoder is the authority on what was really
	// there. They agree for every well-formed file, and where they do not the smaller claim was the
	// one that got past the gate.
	requireWithinDimensions(decoded.width, decoded.height, bounds.maxDimension);

	return decoded;
}

/**
 * Refuses more bytes than the cap.
 *
 * Split out so a caller that has to run this check earlier — the asset upload action turns a file
 * away from its declared size, before pulling it into memory — says the same thing this module
 * would have said, from the same sentence rather than from a copy of it. That caller's check is the
 * early one; the one inside {@link measureImage}, behind it, is the one that cannot be skipped.
 *
 * @param byteLength how many bytes the file is
 * @param maxBytes this caller's byte cap
 * @throws ApiError if that is beyond the cap
 */
export function requireWithinBytes(byteLength: number, maxBytes: number): void {
	if (byteLength > maxBytes) {
		throw new ApiError(
			"body_too_large",
			`An image must be at most ${describeBytes(maxBytes)}; this one is ${describeBytes(byteLength)}.`,
		);
	}
}

/**
 * Refuses bytes whose declared size is beyond what this system will decode.
 *
 * Runs before `decodeImage`, which is the entire point: the allocation this guards against happens
 * *inside* the decode, so a check on the decoded image would be a check made after the damage.
 *
 * A file whose size cannot be read is refused rather than passed on. Only PNG and JPEG are stored,
 * so nothing legitimate is lost — and it closes the hole the other way round, because jimp happily
 * decodes GIF, BMP and TIFF, and an LZW-compressed GIF is every bit as good a bomb as a PNG. Those
 * would otherwise reach the decoder unmeasured and only be turned away afterwards, by which time
 * the memory has already been spent.
 *
 * **Interlaced PNGs are refused, and this is the load-bearing part.** Measuring an image is only
 * worth anything if the decoder then allocates according to what was measured, and for Adam7 it
 * does not. `pngjs@7.0.0/lib/parser-sync.js` has two branches: at line 85 a non-interlaced image
 * inflates with `maxLength: imageSize`, bounded by exactly the width and height read above; at line
 * 80 an interlaced one calls `zlib.inflateSync` with no bound at all. So a PNG that declares 16x16
 * and sets interlace to 1 sails through every check here and then inflates to whatever its IDAT
 * holds, which the byte cap limits only via zlib's ~1032:1 ceiling. Measured on this codebase: a
 * 255 KB file declaring 16x16 drove a 256 MB inflate and took the process up by 524 MB. It throws
 * afterwards, which is no help — the allocation is the thing being defended against.
 *
 * Refusing Adam7 outright puts every PNG this system decodes on the bounded branch, so the
 * dimensions actually bound the decode. Nothing is lost: interlacing exists to preview an image
 * progressively over a slow link, which is meaningless for a logo that is going to a thermal
 * printer, and every image editor writes non-interlaced by default.
 *
 * @param bytes the image
 * @param maxDimension the largest this caller will decode, in pixels on either side
 * @returns what the header declared, so a caller with a bound of its own to apply before the decode
 *          — `asset-service.ts`'s projected raster height — does not have to read the header again
 * @throws ApiError if the size cannot be read, the PNG is interlaced, or either side is beyond
 *         `maxDimension`
 */
export function requireDecodableSize(bytes: Buffer, maxDimension: number): DeclaredImage {
	const declared = declaredSize(bytes);
	if (!declared) {
		throw new ApiError("invalid_image", "Images must be PNG or JPEG.");
	}
	if (declared.interlaced) {
		// Checked before the dimensions, because for an interlaced PNG the dimensions are exactly
		// the thing that has stopped being true.
		throw new ApiError(
			"invalid_image",
			"Interlaced (Adam7) PNGs are not accepted. Save this image without interlacing and upload it again.",
		);
	}
	requireWithinDimensions(declared.width, declared.height, maxDimension);
	return declared;
}

/**
 * Refuses a size beyond the cap.
 *
 * @param width pixels across
 * @param height pixels down
 * @param maxDimension the largest this caller will decode, in pixels on either side
 * @throws ApiError if either side is beyond `maxDimension`
 */
function requireWithinDimensions(width: number, height: number, maxDimension: number): void {
	if (width > maxDimension || height > maxDimension) {
		throw new ApiError(
			"image_too_large",
			`An image must be at most ${maxDimension} pixels on each side; this one is ${width}x${height}.`,
		);
	}
}

/** The PNG signature, which is also this pipeline's test for whether a file is a PNG at all. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The shortest prefix carrying everything this module reads from a PNG.
 *
 * Signature, chunk length, chunk type, width, height, and then past bit depth and colour type to
 * the interlace method at byte 28 — which has to be read, and is the reason this is 29 rather than
 * the 24 that width and height alone would need. See {@link requireDecodableSize}.
 */
const PNG_HEADER_LENGTH = 29;

/** Offset of the IHDR interlace method. 0 is none; 1 is Adam7. */
const PNG_INTERLACE_OFFSET = 28;

/**
 * Reads an image's size out of its header, without decoding it.
 *
 * @param bytes the file
 * @returns what the header declares, or null if these are not bytes this module can measure
 */
function declaredSize(bytes: Buffer): DeclaredImage | null {
	if (bytes.length >= PNG_HEADER_LENGTH && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
		// IHDR is mandated to be the first chunk, so its fields sit at fixed offsets: eight bytes
		// of signature, four of chunk length, four of chunk type, then width, height, bit depth,
		// colour type, compression, filter and interlace.
		return {
			width: bytes.readUInt32BE(16),
			height: bytes.readUInt32BE(20),
			interlaced: bytes[PNG_INTERLACE_OFFSET] !== 0,
		};
	}
	// SOI. Everything after it has to be walked; see jpegSize.
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		return jpegSize(bytes);
	}
	return null;
}

/**
 * JPEG markers that introduce a frame, and therefore carry the image's size.
 *
 * The whole 0xC0–0xCF range except 0xC4, 0xC8 and 0xCC, which are a Huffman table, a reserved
 * extension and an arithmetic-coding table — the three that sit in the range without being frames.
 * Baseline is 0xC0 and progressive is 0xC2; the rest are the lossless and hierarchical modes, and
 * they are included because a decoder that reads them is a decoder that allocates for them.
 */
const JPEG_FRAME_MARKERS: readonly number[] = [
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
];

/**
 * Walks a JPEG's marker segments to the frame header.
 *
 * Unlike PNG there is no fixed offset: EXIF, colour profiles and comments all sit between the start
 * of the file and the frame, each as a segment carrying its own length. So the segments are stepped
 * over until a frame marker turns up, which is where the size is.
 *
 * @param bytes the file, already known to start with SOI
 * @returns its declared pixel size, or null if no frame header could be reached
 */
function jpegSize(bytes: Buffer): DeclaredImage | null {
	let at = 2;

	while (at + 3 < bytes.length) {
		if (bytes[at] !== 0xff) {
			// Not standing on a marker, so the walk has lost its place — most likely because this
			// is not really a JPEG. Refusing beats guessing.
			return null;
		}

		// A marker may be padded with any number of extra 0xff bytes before its code.
		let code = bytes[at + 1];
		while (code === 0xff && at + 2 < bytes.length) {
			at++;
			code = bytes[at + 1];
		}
		at += 2;

		// Markers that stand alone: restart intervals, TEM, and a second SOI. No length follows.
		if (code === 0x01 || (code >= 0xd0 && code <= 0xd8)) {
			continue;
		}
		if (at + 1 >= bytes.length) {
			return null;
		}

		const segment = bytes.readUInt16BE(at);
		if (segment < 2) {
			return null;
		}
		if (JPEG_FRAME_MARKERS.includes(code)) {
			// Length, then one byte of sample precision, then height and width in that order.
			if (at + 7 > bytes.length) {
				return null;
			}
			// `interlaced` is a PNG concept; JPEG's progressive mode is a different mechanism and
			// is not what the unbounded-inflate branch keys off, so it is not what this flag means.
			return { height: bytes.readUInt16BE(at + 3), width: bytes.readUInt16BE(at + 5), interlaced: false };
		}
		at += segment;
	}

	return null;
}
