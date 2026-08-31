import "server-only";
import { AVATAR_MAX_BYTES, type CropRect } from "@/lib/auth/avatar-image";
import { ApiError } from "@/lib/errors";
import { requireWithinBytes } from "@/lib/images/guard";

/**
 * Reading the file and the crop out of a submitted avatar form.
 *
 * Shared rather than kept private to one action's module: both `setOwnAvatar` (Task 8) and
 * `setUserAvatar` (Task 9) submit the identical shape — a `file`, and `x`/`y`/`size` as three
 * separate fields rather than one JSON blob, because a `FormData` value is a string or a `File` and
 * nothing else. Two copies of the byte-cap check here would be two places for the cap to drift.
 */

/** What one submitted avatar form resolves to: the bytes as uploaded, and the requested crop. */
export interface AvatarForm {
	bytes: Buffer;
	crop: CropRect;
}

/**
 * Reads one crop coordinate off the form.
 *
 * @param formData the submitted form
 * @param key `x`, `y`, or `size`
 * @returns the parsed integer
 * @throws ApiError when the field is missing or not a whole number
 */
function readCropField(formData: FormData, key: "x" | "y" | "size"): number {
	const raw = formData.get(key);
	const value = typeof raw === "string" ? Number(raw) : Number.NaN;
	if (!Number.isInteger(value)) {
		throw new ApiError("invalid_type", `The crop's ${key} must be a whole number.`);
	}
	return value;
}

/**
 * Pulls the file and the crop rectangle off a submitted avatar form.
 *
 * **Refuses an oversized file before reading its bytes.** `file.size` is the size the browser
 * declared, checked against {@link AVATAR_MAX_BYTES} before `arrayBuffer()` ever runs — the same
 * order `uploadAsset` and `replaceAsset` use in `app/(panel)/assets/actions.ts`, and for the same
 * reason: the point of a declared-size check is to turn the upload away before it is pulled into
 * memory, not after. `setAvatar` checks the bytes that actually arrived, behind this.
 *
 * The crop is not validated against the image here — only that its three fields are whole numbers.
 * Whether it actually fits inside the decoded image is `bakeAvatar`'s question, which needs the
 * image's real dimensions to answer.
 *
 * @param formData a `file`, and `x`, `y`, `size` as three whole-number fields
 * @returns the uploaded bytes and the requested crop
 * @throws ApiError when the file is missing, or a crop field is not a whole number, or the file is
 *   over the cap
 */
export async function readAvatarForm(formData: FormData): Promise<AvatarForm> {
	const file = formData.get("file");
	if (!(file instanceof File) || file.size === 0) {
		throw new ApiError("missing_field", "Choose an image to upload.");
	}

	const crop: CropRect = {
		x: readCropField(formData, "x"),
		y: readCropField(formData, "y"),
		size: readCropField(formData, "size"),
	};

	requireWithinBytes(file.size, AVATAR_MAX_BYTES);

	return { bytes: Buffer.from(await file.arrayBuffer()), crop };
}
