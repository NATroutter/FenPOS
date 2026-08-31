import "server-only";
import { Jimp, JimpMime } from "jimp";
import { DECODE_LIMITS } from "@/lib/assets/dither";
import { ApiError } from "@/lib/errors";
import { type ImageBounds, measureImage } from "@/lib/images/guard";

/**
 * Turning an uploaded picture and a rectangle into the square that gets served.
 *
 * Every byte that reaches jimp here has already been through {@link measureImage}, which is the
 * only reason a decode on this path is safe — see the shared guard's note on optimistic decoder
 * accounting.
 */

/** The side length of the render actually served. */
export const AVATAR_RENDER_PX = 512;

/**
 * The upload cap, fixed rather than a setting.
 *
 * `assets.maxUploadMb` is an operator's call about receipt logos, which an install might reasonably
 * want large. An avatar is cropped to 512px whatever arrives, so a bigger allowance buys nothing but
 * decode cost and a bigger row.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Mirrors the asset store's `MAX_IMAGE_DIMENSION`; the decoder defence is the same one. */
export const AVATAR_MAX_DIMENSION = 4096;

/** PNG and JPEG, the two the decoder is hardened for. */
export const AVATAR_BOUNDS: ImageBounds = {
	maxBytes: AVATAR_MAX_BYTES,
	maxDimension: AVATAR_MAX_DIMENSION,
	acceptedMimeTypes: [JimpMime.png, JimpMime.jpeg],
};

/** A square region of the original, in its pixels. */
export interface CropRect {
	x: number;
	y: number;
	size: number;
}

/** The render, and what it turned out to be. */
export interface BakedAvatar {
	bytes: Buffer;
	/** The **render's** type, which is always PNG — see {@link bakeAvatar}. */
	mimeType: string;
	size: number;
	/**
	 * The **original's** type, as the decoder found it rather than as the upload claimed.
	 *
	 * A second field rather than a reinterpretation of `mimeType`: the two differ for every JPEG
	 * upload, and a caller storing this one under `Avatar.originalMimeType` would silently record PNG
	 * for the whole of it if the render's type were reused here. It rides along because
	 * {@link measureImage} has already established it inside this function, and the alternative — the
	 * caller measuring the same bytes again purely to read this one string — was a third full decode
	 * of an upload on a path any authenticated account can drive in a loop.
	 */
	originalMimeType: string;
}

/**
 * Refuses a crop the original cannot satisfy.
 *
 * Checked on the server against the decoded dimensions rather than trusted from the dialog: the
 * rectangle arrives as three numbers in a form submission, and jimp's `crop` on a region running
 * past the edge does not throw — it returns a smaller image, which would be stored as a square that
 * is not one.
 *
 * @param crop the requested region
 * @param within the original's decoded dimensions
 * @throws ApiError when the region is not a whole square inside the original
 */
export function requireValidCrop(crop: CropRect, within: { width: number; height: number }): void {
	if (!Number.isInteger(crop.x) || !Number.isInteger(crop.y) || !Number.isInteger(crop.size)) {
		throw new ApiError("invalid_type", "A crop must be whole pixels.");
	}
	if (crop.size <= 0) {
		throw new ApiError("invalid_type", "A crop must have a size.");
	}
	if (crop.x < 0 || crop.y < 0) {
		throw new ApiError("invalid_type", "A crop must start inside the image.");
	}
	if (crop.x + crop.size > within.width || crop.y + crop.size > within.height) {
		throw new ApiError("invalid_type", "That crop runs past the edge of the image.");
	}
}

/**
 * Bakes the square that gets served.
 *
 * @param original the bytes as uploaded
 * @param crop the region to take
 * @returns the render
 * @throws ApiError when the original is unacceptable or the crop does not fit it
 */
export async function bakeAvatar(original: Buffer, crop: CropRect): Promise<BakedAvatar> {
	const decoded = await measureImage(original, AVATAR_BOUNDS);
	requireValidCrop(crop, decoded);

	// The same limits `decodeImage` decodes under. Nothing that exceeds the budget can reach this
	// line — `measureImage` above is the gate and it decodes first — so this is the bound holding by
	// construction rather than by that ordering remaining true.
	const image = await Jimp.fromBuffer(original, DECODE_LIMITS);
	image.crop({ x: crop.x, y: crop.y, w: crop.size, h: crop.size });
	image.resize({ w: AVATAR_RENDER_PX, h: AVATAR_RENDER_PX });

	// PNG regardless of what arrived. The render is small and square, the size difference against
	// JPEG at these dimensions is not worth a second stored mime type to reason about, and PNG is
	// lossless so a re-crop of an already-cropped upload does not compound artefacts.
	return {
		bytes: await image.getBuffer(JimpMime.png),
		mimeType: JimpMime.png,
		size: AVATAR_RENDER_PX,
		// Carried out of here rather than measured again by the caller: see {@link BakedAvatar}.
		originalMimeType: decoded.mimeType,
	};
}
