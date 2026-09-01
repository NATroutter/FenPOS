import "server-only";
import { AVATAR_BOUNDS, bakeAvatar, type CropRect } from "@/lib/auth/avatar-image";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { measureImage } from "@/lib/images/guard";

/**
 * Reading and writing one account's avatar.
 *
 * The bytes never leave this module except through {@link readAvatar}, which the serving route
 * uses, and {@link readAvatarOriginal}. Nothing else needs them, and a list of accounts that
 * returned image bytes per row would be a page that reads megabytes to draw thumbnails — see
 * {@link usersWithAvatars}.
 *
 * **{@link readAvatarOriginal} and {@link recropAvatar} have no production caller yet.** The
 * `original` column and both functions exist because the schema is deliberately forward-looking: the
 * upload is *kept for* re-cropping, so widening a crop later can recover pixels the 512px render no
 * longer holds. What is not built is the dialog that would use them — `AvatarDialog` never fetches a
 * stored original, and its Save is disabled without a freshly picked file, so today every crop change
 * starts from picking the file again. Both are covered by `test/lib/auth/avatar-service.test.ts` and
 * are the working half of a feature whose UI is a follow-up.
 */

/** The render, as served. */
export interface StoredAvatar {
	/**
	 * The bytes, over a backing store known to be a plain `ArrayBuffer`.
	 *
	 * The type parameter is the whole point: bare `Buffer` is `Buffer<ArrayBufferLike>`, which may be
	 * backed by a `SharedArrayBuffer` and so is not assignable to `BodyInit`. `Buffer.from` below
	 * produces exactly this narrower type, and saying so is what lets the serving route hand these
	 * bytes straight to a `Response` instead of copying every one of them into a fresh `Uint8Array`
	 * to satisfy the compiler.
	 */
	bytes: Buffer<ArrayBuffer>;
	mimeType: string;
	/** The row's own `updatedAt`, which the serving route turns into an ETag. */
	updatedAt: Date;
}

/** The original and its current crop, for re-cropping. */
export interface AvatarOriginal {
	bytes: Buffer;
	mimeType: string;
	crop: CropRect;
	width: number;
	height: number;
}

/**
 * Stores a new picture and the crop taken from it.
 *
 * An upsert rather than a create: replacing your avatar is the ordinary case, and a unique-key
 * failure is not something a caller should have to distinguish from a real one.
 *
 * @param userId whose avatar
 * @param original the bytes as uploaded
 * @param crop the region to take
 * @throws ApiError when the image or the crop is unacceptable
 */
export async function setAvatar(userId: string, original: Buffer, crop: CropRect): Promise<void> {
	// Bakes first, and deliberately before any write: `bakeAvatar` is what refuses an unacceptable
	// image or an impossible crop, so a refusal here leaves the previous avatar untouched rather
	// than half-replaced.
	const baked = await bakeAvatar(original, crop);

	const row = {
		// Copied into a plain `Uint8Array` for the reason `asset-service.ts` gives: Prisma's `Bytes`
		// will not take a `Buffer`, whose backing store is typed as possibly shared.
		original: new Uint8Array(original),
		// From the bake, not from a second `measureImage` of the same bytes. This used to call the
		// guard again purely to read one string, which decoded the upload a third time — on
		// `self:set-avatar`, which is deliberately ungated and so is a loop any authenticated account
		// can drive. `bakeAvatar` had already measured it; it now says what it found.
		originalMimeType: baked.originalMimeType,
		cropX: crop.x,
		cropY: crop.y,
		cropSize: crop.size,
		baked: new Uint8Array(baked.bytes),
		bakedMimeType: baked.mimeType,
		bakedSize: baked.size,
	};

	await prisma.avatar.upsert({ where: { userId }, create: { userId, ...row }, update: row });
}

/**
 * Re-bakes the stored original under a new crop.
 *
 * @param userId whose avatar
 * @param crop the new region
 * @throws ApiError when there is no avatar, or the crop does not fit the original
 */
export async function recropAvatar(userId: string, crop: CropRect): Promise<void> {
	const existing = await prisma.avatar.findUnique({ where: { userId }, select: { original: true } });
	if (existing === null) {
		throw new ApiError("unknown_avatar", "That account has no avatar to re-crop.");
	}

	const baked = await bakeAvatar(Buffer.from(existing.original), crop);

	await prisma.avatar.update({
		where: { userId },
		data: {
			cropX: crop.x,
			cropY: crop.y,
			cropSize: crop.size,
			baked: new Uint8Array(baked.bytes),
			bakedMimeType: baked.mimeType,
			bakedSize: baked.size,
		},
	});
}

/**
 * Removes an account's avatar.
 *
 * `deleteMany` rather than `delete` so a missing row is a count of zero rather than a thrown P2025
 * this function would only have to catch and rewrite.
 *
 * @param userId whose avatar
 * @throws ApiError when there was none
 */
export async function removeAvatar(userId: string): Promise<void> {
	const { count } = await prisma.avatar.deleteMany({ where: { userId } });
	if (count === 0) {
		throw new ApiError("unknown_avatar", "That account has no avatar to remove.");
	}
}

/**
 * The render to serve, or null when the account has none.
 *
 * @param userId whose avatar
 * @returns the bytes, their type, and when they were last written
 */
export async function readAvatar(userId: string): Promise<StoredAvatar | null> {
	const row = await prisma.avatar.findUnique({
		where: { userId },
		select: { baked: true, bakedMimeType: true, updatedAt: true },
	});
	if (row === null) {
		return null;
	}
	return { bytes: Buffer.from(row.baked), mimeType: row.bakedMimeType, updatedAt: row.updatedAt };
}

/**
 * The original and its crop, for a dialog that would re-crop it — none does yet; see this module's
 * own doc.
 *
 * The dimensions are decoded here rather than stored, because they are needed only on this path and
 * a stored pair is a pair that can disagree with the bytes.
 *
 * @param userId whose avatar
 * @returns the original, or null when the account has none
 */
export async function readAvatarOriginal(userId: string): Promise<AvatarOriginal | null> {
	const row = await prisma.avatar.findUnique({
		where: { userId },
		select: { original: true, originalMimeType: true, cropX: true, cropY: true, cropSize: true },
	});
	if (row === null) {
		return null;
	}

	const bytes = Buffer.from(row.original);
	const decoded = await measureImage(bytes, AVATAR_BOUNDS);

	return {
		bytes,
		mimeType: row.originalMimeType,
		crop: { x: row.cropX, y: row.cropY, size: row.cropSize },
		width: decoded.width,
		height: decoded.height,
	};
}

/**
 * Which of these accounts have an avatar at all, and when each was last written.
 *
 * Ids and stamps only. The users page draws a row per account and needs to know whether to point an
 * `<img>` at the serving route or draw the initial; selecting `baked` to answer that would read
 * every stored picture to render a list that shows none of them at full size.
 *
 * **The stamp is what makes a re-crop visible.** The serving route's URL is `/api/avatar/<id>` and
 * nothing else, so replacing a picture leaves every `<img>` on the page pointing at a string that
 * did not change — React keeps the same element, the browser never revalidates it, and the old face
 * stays on screen until a hard reload. A caller that puts this stamp in the query string gets a new
 * URL when and only when the bytes change; the route's own ETag still makes the repeat cheap.
 *
 * A `Map` rather than a `Set` so `has` and `size` read the same at every existing call site.
 *
 * @param userIds the accounts on the page
 * @returns those that have one, against the row's `updatedAt`
 */
export async function usersWithAvatars(userIds: readonly string[]): Promise<ReadonlyMap<string, Date>> {
	if (userIds.length === 0) {
		return new Map();
	}
	const rows = await prisma.avatar.findMany({
		where: { userId: { in: [...userIds] } },
		select: { userId: true, updatedAt: true },
	});
	return new Map(rows.map((row) => [row.userId, row.updatedAt]));
}
