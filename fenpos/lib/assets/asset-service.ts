import "server-only";
import { BUNDLED_LOGO_NAME } from "@/lib/assets/bundled-logo";
import {
	type AcceptedFormatsSetting,
	type DecodedImage,
	ditherToRaster,
	FORMAT_MIME_TYPES,
	type ImageRaster,
	projectedHeightDots,
} from "@/lib/assets/dither";
import { fetchRemoteImage, type RemoteFetchSettings, safeUrl } from "@/lib/assets/fetch-remote";
import { type DetectedKind, detectAssetKind } from "@/lib/assets/kind";
import { prisma } from "@/lib/db";
import { AssetKind } from "@/lib/domain/enums";
import { nameSchema } from "@/lib/domain/naming";
import { ApiError } from "@/lib/errors";
import { measureImage, requireDecodableSize, requireWithinBytes } from "@/lib/images/guard";
import { IMAGE_LIMITS } from "@/lib/link/protocol";
import { logger } from "@/lib/logger";
import type { ImageSource } from "@/lib/markup/images";
import { type FontFace, InvalidFontError, parseFace } from "@/lib/raster/glyphs";
import { enumSetting, integerSetting } from "@/lib/settings/settings-service";

/**
 * The library a receipt draws its images and its fonts from.
 *
 * **One table and one namespace.** Markup names an asset by name alone, so an image and a font
 * cannot share one — which is what the unique constraint on `name` says, and why the kind is read
 * from the bytes rather than taken from the caller. What the two kinds do not share is anything
 * else: an image is decoded, measured and dithered, a font is parsed and rasterised a glyph at a
 * time, and each is refused by the rules of its own kind.
 *
 * **The source image is stored; the raster is derived.** A raster dithered for 80mm paper is 504
 * dots wide, and putting it on a 58mm printer means downscaling dots that have already been
 * reduced to black and white — resampling the dither's own noise, which turns a logo into mud. One
 * install can have both widths behind a single agent, so there is no width that would be the right
 * one to store at. {@link rasterFor} derives a raster per paper width from the bytes as uploaded.
 *
 * Decoding on the way in doubles as validation. A file that will not decode is refused at upload,
 * while the person who chose it is still looking at the file picker, rather than at print time
 * behind a printer where nobody can act on it.
 *
 * Two entry points put image bytes into this table — an upload and a URL import — and both go
 * through {@link store}. A third reads bytes without storing them at all: {@link remoteImage}
 * measures the live URL an `<image>` tag can name. All three go through {@link measured}, so a
 * bound added here cannot be walked around by choosing another door. A font has one door,
 * {@link storeFont}, and one gate, {@link requireUsableFont}.
 */

/**
 * The largest asset this system will store, in bytes.
 *
 * Read from the `assets.maxUploadMb` setting — an operator's own call, an install storing mostly
 * logos and one fetching full photographs want different answers — rather than a fixed constant.
 * The same figure bounds an upload and an import alike, because both go through {@link store}.
 * Stated here rather than left to Next's server-action body limit: a limit inherited from a
 * framework default is one nobody can find, and upgrading the framework would silently change the
 * product. `next.config.ts` raises its own ceiling above the setting's declared maximum on purpose,
 * so that this is what actually decides, whatever an operator sets it to —
 * `settings-service.test.ts` is what keeps that ceiling from drifting back below it.
 *
 * This bounds the bytes that arrive. It does not bound what they decode to — see
 * {@link MAX_IMAGE_DIMENSION}, which is the bound that matters.
 *
 * @returns the configured cap, in bytes
 */
export async function maxAssetBytes(): Promise<number> {
	return (await integerSetting("assets.maxUploadMb")) * 1024 * 1024;
}

/**
 * The largest font this system will store, in bytes.
 *
 * A separate setting from {@link maxAssetBytes} because the two are different files with different
 * honest sizes: a receipt logo is kilobytes, while a face covering CJK is tens of megabytes and
 * still perfectly reasonable to upload. One cap covering both would have to be the larger of the
 * two, which would quietly widen what an image upload may be.
 *
 * The bound is on the bytes alone. Unlike an image, nothing about a font decompresses on the way in
 * — {@link fontFace} parses the tables it is asked for and rasterises glyphs one at a time — so
 * there is no decode budget behind this the way {@link MAX_IMAGE_DIMENSION} stands behind the image
 * cap.
 *
 * @returns the configured cap, in bytes
 */
export async function maxFontBytes(): Promise<number> {
	return (await integerSetting("assets.maxFontUploadMb")) * 1024 * 1024;
}

/**
 * The one asset name this module refuses to store anything under.
 *
 * The agent bundles its own logo for the device test page — see `BundledImages.NAME` in
 * `agent/src/main/java/fi/natroutter/fenpos/print/BundledImages.java` — under this exact name, and
 * a bundled image always wins over a synced one of the same name (`PrintImages`, on the agent side).
 * `"fenpos"` is a legal slug by {@link nameSchema}, so nothing about its shape stops an operator
 * from choosing it too. Without this guard, an asset created or imported under this name would be
 * shadowed by the bundled logo and would silently never print — no error, just the wrong image on
 * every device that has this logo bundled for its paper width. Refusing the name at creation is
 * what turns that into an error an operator can act on instead.
 *
 * The panel answers for the same name itself, out of `bundled-logo.ts`, and does so *before* any
 * row is looked up — so a row committed before this guard existed cannot shadow the logo either.
 * The constant is that module's, rather than a second copy of the string, so the name refused here
 * and the name resolved there cannot drift apart.
 *
 * Deliberately not part of {@link nameSchema}: that schema also governs agent and device names,
 * which have nothing to do with the bundled logo and should not be told `"fenpos"` is off limits.
 */
export const RESERVED_ASSET_NAME = BUNDLED_LOGO_NAME;

/**
 * The largest image this system will decode, in pixels on either side.
 *
 * A byte cap bounds nothing about memory here, because PNG is compressed and a uniform image
 * compresses almost perfectly. Measured on this codebase: a 140 KB PNG declaring 12000x12000
 * decodes to a 549 MB bitmap and takes the process to 982 MB resident. That is a decompression
 * bomb, it fits inside the 2 MB cap with room to spare, and the upload path is where it arrives.
 *
 * 4096 is the trade. A thermal printer's widest common paper is 504 dots, so 4096 is already eight
 * times more source than any receipt can use — but it is also more than a phone photograph, which
 * comes off a 12 MP sensor at 4032x3024, so nobody uploading a picture they just took is told no.
 *
 * **What 4096x4096 actually costs**, measured through `decodeImage` on this machine, as the extra
 * resident memory each takes:
 *
 * - 8-bit RGBA PNG: +196 MB
 * - 16-bit RGBA PNG: +333 MB — bit depth feeds the inflate bound, so this doubles the 8-bit case
 * - 4:4:4 three-component JPEG: about +500 MB, and reached from a 21-byte frame header, because
 *   `jpeg-js` allocates coefficient blocks while parsing the header rather than while decoding a
 *   scan
 *
 * So the honest ceiling this constant buys is a few hundred megabytes, worst observed +500 MB —
 * not the 147 MB an earlier version of this comment claimed from one greyscale sample. A shop's
 * server absorbs that; the point is that it is bounded and knowable, and everything past 4096 is
 * either a mistake or an attack.
 *
 * Checked from the file's header rather than from the decoded image, because a check that runs
 * after `decodeImage` runs after the allocation it exists to prevent. See `declaredSize` in
 * `lib/images/guard.ts`.
 *
 * **This number bounds nothing on its own.** It holds only alongside two other limits, and all
 * three have to be read together:
 *
 * - `requireDecodableSize` in `lib/images/guard.ts` refusing interlaced PNGs, without which `pngjs` inflates
 *   unbounded and the dimensions stop governing anything
 * - `MAX_JPEG_DECODE_MB` and `MAX_JPEG_MEGAPIXELS` in `dither.ts`, without which `jpeg-js` will
 *   allocate to its own 512 MB budget — worth about 1.3 GB of real memory — regardless of what is
 *   declared here
 */
export const MAX_IMAGE_DIMENSION = 4096;

/**
 * The widest paper any install of this system can be configured for, in printer dots.
 *
 * `dotWidth(255)`: a device's `columns` is bounded to 255 by `deviceInputSchema`, and one column is
 * twelve dots. Restated here rather than imported because `lib/markup/blocks.ts` pulls bwip-js and
 * its 110 encoders in behind `dotWidth`, which is a two-megabyte dependency for one multiplication
 * on a module that has nothing else to do with symbols. `asset-service.test.ts` asserts this equals
 * `dotWidth(255)` and that 255 is really the schema's ceiling, so the duplication cannot drift
 * silently — the same arrangement `MAX_JPEG_MEGAPIXELS` uses in `dither.ts`.
 *
 * It is the *widest* width that matters, because {@link projectedHeightDots} grows with it: a
 * source refused here is refused at every narrower paper too, so one check covers every device an
 * install could later add without re-measuring anything already stored.
 */
export const MAX_PAPER_DOTS = 3060;

/** An asset as the Assets tab lists it. Deliberately without the bytes. */
export interface AssetSummary {
	id: string;
	kind: AssetKind;
	name: string;
	/** Pixels across and down for an image, and null for a font, which has no pixels to report. */
	width: number | null;
	height: number | null;
	mimeType: string;
	/** Where it was imported from, for provenance only. Never re-fetched. Null when uploaded. */
	sourceUrl: string | null;
	createdAt: string;
}

/**
 * A row as {@link SUMMARY_COLUMNS} selects it.
 *
 * Stated rather than inferred from Prisma's `create` return type, which does not narrow to the
 * `select` in a way a local variable can be annotated with.
 */
interface AssetRow {
	id: string;
	kind: string;
	name: string;
	width: number | null;
	height: number | null;
	mimeType: string;
	sourceUrl: string | null;
	createdAt: Date;
}

/** The columns a summary is built from, so no query accidentally drags a megabyte of `data` along. */
const SUMMARY_COLUMNS = {
	id: true,
	kind: true,
	name: true,
	width: true,
	height: true,
	mimeType: true,
	sourceUrl: true,
	createdAt: true,
} as const;

/**
 * Lists stored assets.
 *
 * @param kind narrows to one kind; omit for every kind, which is what the Assets tab shows
 * @returns assets ordered by name, without their bytes
 */
export async function listAssets(kind?: AssetKind): Promise<AssetSummary[]> {
	const rows = await prisma.asset.findMany({
		...(kind ? { where: { kind } } : {}),
		orderBy: { name: "asc" },
		select: SUMMARY_COLUMNS,
	});
	return rows.map(summarise);
}

/**
 * Stores an uploaded image or font.
 *
 * **Which of the two it is comes from the bytes**, through {@link detectAssetKind}, rather than from
 * a filename or a content type the uploader chose. The two are then held to different rules — an
 * image is decoded and measured, a font is parsed — and neither set would say anything useful about
 * the other.
 *
 * @param name what markup will refer to it by; slug-shaped
 * @param bytes the file exactly as uploaded
 * @returns the stored asset
 * @throws ApiError if the name is unusable or taken, the file is too large, too big in pixels, or
 *         is neither an image this pipeline prints nor a font it can read
 */
export async function createAsset(name: string, bytes: Buffer): Promise<AssetSummary> {
	const detected = detectAssetKind(bytes);
	if (detected === null) {
		throw new ApiError("invalid_image", "Files must be a PNG or JPEG image, or a TTF or OTF font.");
	}
	if (detected.kind === "FONT") {
		return storeFont(name, bytes, detected.mimeType);
	}
	return store(name, bytes, null);
}

/**
 * Fetches an image by URL and stores it.
 *
 * The fetch is `fetchRemoteImage`, the guarded one, and there is deliberately no second fetch path
 * in this module: a URL supplied here reaches the same SSRF guard, timeout and streaming cap as
 * one written into a receipt.
 *
 * The name is settled before the fetch. A typo or a duplicate should not cost a network round trip
 * to a host the operator named, and it should not be reported only after the wait.
 *
 * **The raw URL is fetched; the redacted one is stored.** A URL may carry credentials, and
 * `fetch-remote.ts` deliberately supports that — an image host behind Basic auth is a real thing —
 * but it holds the line that they go to the server and nowhere else. `sourceUrl` is provenance,
 * never re-fetched, so it has no use for a password, and writing one into a database column and a
 * log line would be a far more durable leak than the error-message one that module already closed.
 * Hence {@link safeUrl} on the way into storage and only there.
 *
 * @param name what markup will refer to it by; slug-shaped
 * @param url where to fetch it from
 * @returns the stored asset, carrying the URL — minus any credentials — for provenance
 * @throws ApiError if the name is unusable or taken, the fetch is refused, or the image is too
 *         large in bytes or in pixels
 */
export async function importAssetFromUrl(name: string, url: string): Promise<AssetSummary> {
	const parsed = parseName(name);
	await requireNameFree(parsed);

	const bytes = await fetchRemoteImage(url);

	return store(parsed, bytes, safeUrl(url));
}

/**
 * Renames a stored asset.
 *
 * **The name is the reference, not a label on it.** Receipts are written against it, so this has the
 * same consequence a delete does: anything saying `<image>old</image>` is refused from the moment
 * this lands, until it is edited or an image of the old name is stored again. Nothing here looks for
 * references first, for the reason {@link deleteAsset} gives — the panel says so in its confirmation,
 * and a refusal raised here would be one the operator cannot act on from the Assets tab.
 *
 * Everything else survives untouched: the bytes, the dimensions, the provenance, the row's identity.
 * The stored rasters survive too, and correctly — they are keyed by the row's id and `updatedAt`, and
 * this image is still the same picture, so the memoised dots are still the right dots for it.
 *
 * Renaming to the name it already has is accepted rather than refused as a clash. That is what a
 * dialog opened and submitted without an edit sends, and "there is already an asset called logo" is
 * a true and useless thing to say about the row being renamed.
 *
 * @param id the asset to rename
 * @param rawName the new name as supplied
 * @returns the renamed asset
 * @throws ApiError if there is no such asset, or the name is unusable or taken by another asset
 */
export async function renameAsset(id: string, rawName: string): Promise<AssetSummary> {
	const name = parseName(rawName);

	const existing = await prisma.asset.findUnique({ where: { id }, select: { id: true, name: true } });
	if (!existing) {
		throw new ApiError("unknown_asset", "That asset no longer exists.");
	}

	if (existing.name === name) {
		return summarise(await readRow(id));
	}

	await requireNameFree(name);

	let row: AssetRow;
	try {
		row = await prisma.asset.update({ where: { id }, data: { name }, select: SUMMARY_COLUMNS });
	} catch (thrown) {
		// The same two-statement race `store` guards: the check above and this update are separate, so
		// two operators renaming to one name can both pass it. The constraint keeps that correct; this
		// is only about which sentence the loser reads.
		if (isPrismaCode(thrown, "P2002")) {
			throw nameTaken(name, thrown);
		}
		if (isPrismaCode(thrown, "P2025")) {
			throw new ApiError("unknown_asset", "That asset no longer exists.", {}, { cause: thrown });
		}
		throw thrown;
	}

	logger.info("Asset renamed", { assetId: id, from: existing.name, to: name });

	return summarise(row);
}

/**
 * Replaces a stored asset's bytes, keeping its name.
 *
 * The counterpart of {@link renameAsset}: there, the picture stays and the reference moves; here the
 * reference stays and the picture changes. This is what a redrawn logo needs — every receipt printing
 * it goes on printing it, with no edit anywhere, because the name they name is untouched.
 *
 * **The memoised rasters have to stop being served, and they do.** `rasterFor` keys its cache on
 * `${id}:${updatedAt}:${dots}`, and Prisma's `@updatedAt` moves the second of those on any write —
 * so the old dots become unreachable rather than stale, without this function knowing anything about
 * the cache. That coupling is quiet enough to be worth stating: the test for it in
 * `asset-service.test.ts` is what would notice if `updatedAt` ever stopped being touched here.
 *
 * `sourceUrl` is cleared, because it is a record of where these bytes came from and these are not
 * those bytes. Leaving it would attribute an uploaded image to a URL it was never fetched from.
 *
 * **The kind cannot change here.** Everything referring to this row refers to it as what it was —
 * an `<image>` tag or a font attribute — so turning a logo into a font under the same name would
 * break every receipt naming it while looking like a successful replace. Delete and upload is how
 * that is said, and it is a deliberate step rather than a slip of the file picker.
 *
 * @param id the asset to replace
 * @param bytes the new image or font
 * @returns the replaced asset
 * @throws ApiError if there is no such asset, the bytes are of the other kind, or they are not an
 *         image this pipeline prints or a font it can read
 */
export async function replaceAsset(id: string, bytes: Buffer): Promise<AssetSummary> {
	return await put(id, bytes, null);
}

/**
 * Fetches an image by URL and replaces a stored asset's bytes with it.
 *
 * The row is checked before the fetch, for the reason {@link importAssetFromUrl} settles its name
 * first: a mistake that costs a round trip to a host somebody else runs is one worth catching on this
 * side of it.
 *
 * The raw URL is fetched and the redacted one stored, exactly as an import does — see
 * {@link importAssetFromUrl} for why the two differ.
 *
 * @param id the asset to replace
 * @param url where to fetch the new image from
 * @returns the replaced asset, carrying the URL — minus any credentials — for provenance
 * @throws ApiError if there is no such asset, the fetch is refused, or the image is unusable
 */
export async function replaceAssetFromUrl(id: string, url: string): Promise<AssetSummary> {
	await requireAsset(id);

	const bytes = await fetchRemoteImage(url);

	return await put(id, bytes, safeUrl(url));
}

/**
 * The one way a stored asset's bytes are replaced.
 *
 * The measure happens before the write, so an image this pipeline will not print leaves the stored
 * one exactly as it was. That ordering is the whole reason this is not two statements at the call
 * site: a replace that failed halfway would leave a row whose dimensions describe a picture it is not
 * holding, and nothing downstream could tell.
 *
 * @param id the asset to replace
 * @param bytes the new image or font
 * @param sourceUrl where it was fetched from, or null when uploaded
 * @returns the replaced asset
 * @throws ApiError if there is no such asset, the bytes are of the other kind, or on any refusal of
 *         the bytes
 */
async function put(id: string, bytes: Buffer, sourceUrl: string | null): Promise<AssetSummary> {
	const existing = await requireAsset(id);

	const detected = requireSameKind(existing.kind, existing.name, bytes);

	if (detected.kind === "FONT") {
		await requireUsableFont(existing.name, bytes);
	}

	// A font carries no dimensions and an image always does, so both columns are written from
	// whichever branch ran rather than left at whatever the row held.
	const written =
		detected.kind === "FONT" ? { mimeType: detected.mimeType, width: null, height: null } : await measured(bytes);

	let row: AssetRow;
	try {
		row = await prisma.asset.update({
			where: { id },
			data: {
				// Copied into a plain `Uint8Array` for the reason `store` gives: Prisma's `Bytes` will
				// not take a `Buffer`, whose backing store is typed as possibly shared.
				data: new Uint8Array(bytes),
				mimeType: written.mimeType,
				width: written.width,
				height: written.height,
				sourceUrl,
			},
			select: SUMMARY_COLUMNS,
		});
	} catch (thrown) {
		// Deleted between the check and the write, by a second operator on the same tab.
		if (isPrismaCode(thrown, "P2025")) {
			throw new ApiError("unknown_asset", "That asset no longer exists.", {}, { cause: thrown });
		}
		throw thrown;
	}

	logger.info("Asset replaced", {
		assetId: id,
		name: existing.name,
		kind: detected.kind,
		mimeType: written.mimeType,
		width: written.width,
		height: written.height,
		bytes: bytes.length,
		sourceUrl,
	});

	return summarise(row);
}

/**
 * Resolves an asset id to the row behind it.
 *
 * @param id the asset
 * @returns its id, name and kind
 * @throws ApiError if there is no such asset
 */
async function requireAsset(id: string): Promise<{ id: string; name: string; kind: string }> {
	const existing = await prisma.asset.findUnique({
		where: { id },
		select: { id: true, name: true, kind: true },
	});
	if (!existing) {
		throw new ApiError("unknown_asset", "That asset no longer exists.");
	}
	return existing;
}

/**
 * Refuses a replacement that would change what an asset is.
 *
 * @param stored the kind the row holds
 * @param name the asset's name, for the refusal
 * @param bytes the replacement, as uploaded or as fetched
 * @returns what the replacement turned out to be
 * @throws ApiError if the bytes are neither an image nor a font, or are the other kind
 */
function requireSameKind(stored: string, name: string, bytes: Buffer): NonNullable<DetectedKind> {
	const detected = detectAssetKind(bytes);
	if (detected === null) {
		throw new ApiError("invalid_image", "Files must be a PNG or JPEG image, or a TTF or OTF font.");
	}
	if (detected.kind !== stored) {
		const was = stored === "FONT" ? "a font" : "an image";
		const now = detected.kind === "FONT" ? "a font" : "an image";
		throw new ApiError("invalid_type", `'${name}' is ${was} and cannot be replaced by ${now}.`);
	}
	return detected;
}

/**
 * Reads a stored asset's summary columns.
 *
 * @param id the asset
 * @returns the row
 * @throws ApiError if it has gone since it was last read
 */
async function readRow(id: string): Promise<AssetRow> {
	const row = await prisma.asset.findUnique({ where: { id }, select: SUMMARY_COLUMNS });
	if (!row) {
		throw new ApiError("unknown_asset", "That asset no longer exists.");
	}
	return row;
}

/**
 * Deletes an asset.
 *
 * Nothing checks whether markup still references it. A receipt naming a deleted asset fails at
 * compile time with an unknown-asset message, which is a clearer thing to read than a delete the
 * panel refused for reasons the operator cannot see from the Assets tab.
 *
 * @param id the asset to delete
 * @throws ApiError if there is no such asset
 */
export async function deleteAsset(id: string): Promise<void> {
	const existing = await prisma.asset.findUnique({ where: { id }, select: { id: true, name: true } });
	if (!existing) {
		throw new ApiError("unknown_asset", "That asset no longer exists.");
	}

	try {
		await prisma.asset.delete({ where: { id } });
	} catch (thrown) {
		// Two operators on the Assets tab at once: the check above passed for both, and the second
		// delete finds nothing. The row is gone either way, which is what was asked for — but
		// without this the loser gets Prisma's P2025, which is not an ApiError, so `run()` in the
		// action turns it into "check the server log" for a situation this module has a word for.
		if (!isPrismaCode(thrown, "P2025")) {
			throw thrown;
		}
		throw new ApiError("unknown_asset", "That asset no longer exists.", {}, { cause: thrown });
	}

	logger.info("Asset deleted", { assetId: id, name: existing.name });
}

/**
 * How many bytes of dithered rasters this process keeps in memory.
 *
 * Reads `assets.rasterCacheMb`, converted from MiB. A real receipt logo at the widest common paper
 * is 20-30 KB of dots, so the built-in 8 MiB fallback holds a few hundred — far more than most
 * installs' libraries across their paper widths, which means the eviction this drives is a safety
 * net rather than a working part on a typical install. It is a cap on a *derived* value: everything
 * in here can be rebuilt from `Asset.data`, so losing it costs time and nothing else — which is why
 * an operator can lower it freely on a small machine.
 *
 * Read fresh on every call rather than cached at module load: this runs once per dither, not once
 * per line the way `logs.*` ingestion does, so there is no hot path for the read to regress.
 *
 * @returns the configured cap, in bytes
 */
async function rasterCacheBytes(): Promise<number> {
	return (await integerSetting("assets.rasterCacheMb")) * 1024 * 1024;
}

/**
 * Dithered rasters, keyed by the asset revision and the width they were dithered for.
 *
 * **Memoisation, not storage.** The source image is what is stored; this is a saved result, held
 * because the same few (image, width) pairs are asked for over and over — once per agent connect,
 * once per device edit, once per asset upload, and once per print of an image at an unusual width.
 * Each miss is a multi-megabyte blob read plus a jimp decode, a resize and a Floyd-Steinberg pass.
 *
 * The key carries the asset's id *and* its `updatedAt`, so nothing here can outlive the bytes it was
 * derived from: a re-upload under the same name is a different row and therefore a different key,
 * and an in-place edit moves the timestamp. That is the whole invalidation story — there is no
 * eviction on write to forget, because a stale entry is unreachable rather than merely wrong.
 *
 * `inFlight` is the same memoisation one moment earlier. A cache consulted only before the first
 * `await` does nothing for calls that arrive together, and together is exactly how they arrive:
 * `pushConfigToEveryAgent` fans out over every connected agent at once, so several agents sharing a
 * paper width would each derive the same picture simultaneously and each miss the cold cache. Sharing
 * the promise turns that back into one derivation.
 *
 * Held on `globalThis` for the same reason the link registry is: a development hot reload would
 * otherwise strand the previous module's entries and accumulate a second copy.
 */
const globalForRasters = globalThis as unknown as {
	fenposRasterCache:
		| { entries: Map<string, ImageRaster>; bytes: number; inFlight: Map<string, Promise<ImageRaster>> }
		| undefined;
};

if (!globalForRasters.fenposRasterCache) {
	globalForRasters.fenposRasterCache = { entries: new Map(), bytes: 0, inFlight: new Map() };
}

const rasterCache = globalForRasters.fenposRasterCache;

/**
 * Renders a stored image as a 1-bit raster for a given paper width.
 *
 * **Memoised by asset revision and width.** Dithering is real work — a blob read, a decode, a resize
 * and an error-diffusion pass over every dot — and the same handful of rasters are asked for
 * repeatedly: every agent that connects is sent one per stored image per paper width, and so is
 * every agent when any of them is edited or an image is uploaded. Without this, ten agents with a
 * modest library re-derived the same pictures on every one of those events.
 *
 * The cache lives in memory rather than in a table, which is a smaller commitment than the one this
 * function's earlier note anticipated and enough for what it costs: it is bounded by
 * {@link rasterCacheBytes}, it is correct across restarts by being empty, and it keeps `Asset.data`
 * holding nothing but the source. A cheap read of the row's id and timestamp happens on every call,
 * so a hit still cannot serve dots from bytes that have been replaced.
 *
 * **Callers that arrive together share one derivation.** The cache above is consulted before the
 * first `await`, which does nothing for calls already in flight — and in flight together is how they
 * come: `pushConfigToEveryAgent` pushes every connected agent at once, so a dozen agents on the same
 * paper width would each decode and dither the same image simultaneously against a cold cache. The
 * second and later callers wait on the first one's promise instead.
 *
 * **The returned raster is shared.** Callers read it — encode it, measure it — and must not write
 * through `packed`, which several of them would then be holding.
 *
 * @param name the asset's name
 * @param targetDots the paper width in printer dots, from `dotWidth(columns)`
 * @returns the raster's size in dots and its packed bits, MSB first
 * @throws ApiError if no image of that name is stored, or the asset of that name is a font
 * @throws RangeError if `targetDots` is not a positive whole number of dots
 */
export async function rasterFor(name: string, targetDots: number): Promise<ImageRaster> {
	// Deliberately not selecting `data`: this read runs on every call, including the hits, and the
	// bytes are the expensive part. Two megabytes fetched only to be thrown away would undo most of
	// what the cache is for.
	const revision = await prisma.asset.findUnique({
		where: { name },
		select: { id: true, kind: true, updatedAt: true },
	});
	if (!revision) {
		throw new ApiError("unknown_asset", `There is no image called '${name}'.`);
	}
	requireImage(revision.kind, name);

	const key = `${revision.id}:${revision.updatedAt.getTime()}:${targetDots}`;
	const remembered = rasterCache.entries.get(key);
	if (remembered) {
		// Re-inserted so the map's iteration order is least-recently-used first, which is the order
		// eviction walks. One delete and one set against a decode and a dither.
		rasterCache.entries.delete(key);
		rasterCache.entries.set(key, remembered);
		return remembered;
	}

	const already = rasterCache.inFlight.get(key);
	if (already) {
		return already;
	}

	const deriving = derive(revision.id, name, targetDots, key);
	rasterCache.inFlight.set(key, deriving);

	// Cleared on either outcome, so one failure — a row deleted mid-derive, an image that will not
	// decode — cannot leave the key permanently answering with that failure. The identity check is
	// the same guard `unregisterLink` uses: if something has since replaced this entry, removing it
	// would strand whoever is waiting on the replacement.
	//
	// `then(clear, clear)` rather than `finally`, which re-raises into a derived promise nobody
	// awaits and would surface as an unhandled rejection. The promise handed back is the one the
	// caller handles.
	const clear = () => {
		if (rasterCache.inFlight.get(key) === deriving) {
			rasterCache.inFlight.delete(key);
		}
	};
	deriving.then(clear, clear);

	return deriving;
}

/**
 * Reads the bytes and dithers them, which is the expensive half.
 *
 * Split out so that the promise doing this work is a value {@link rasterFor} can hand to every other
 * caller waiting on the same picture.
 *
 * @param assetId the row to read, already resolved from the name
 * @param name the asset's name, for the refusal
 * @param targetDots the paper width in printer dots
 * @param key the cache key this derivation belongs to
 * @returns the raster
 * @throws ApiError if the row is gone by the time its bytes are read
 */
async function derive(assetId: string, name: string, targetDots: number, key: string): Promise<ImageRaster> {
	const stored = await prisma.asset.findUnique({ where: { id: assetId }, select: { data: true } });
	if (!stored) {
		// Deleted between the two reads. Ordinary with two operators on the Assets tab, and the
		// caller gets the same answer as if it had been gone all along.
		throw new ApiError("unknown_asset", `There is no image called '${name}'.`);
	}

	// Not wrapped: these bytes decoded once already, on the way in. A failure now is this server
	// disagreeing with itself, which is a 500 and a log line, not something the caller did wrong.
	const raster = await ditherToRaster(Buffer.from(stored.data), targetDots);
	await remember(key, raster);
	return raster;
}

/**
 * Stores a raster, evicting the least recently used until the cache is back within its cap.
 *
 * A raster larger than the whole cap is returned to its caller and never stored, rather than
 * emptying the cache to hold one thing nothing else can share.
 *
 * **What is replaced is subtracted before what replaces it is added.** The map holds one entry per
 * key however many times it is written, so a counter that only ever added would drift above the
 * bytes actually held — and since the drift is what the eviction loop reads, it would evict entries
 * that were still wanted while believing it was under the cap. In-flight sharing means two
 * derivations of one key should no longer meet here, but the accounting must not depend on that
 * being true of every path that ever calls this.
 *
 * @param key the asset revision and width this was derived from
 * @param raster the dots
 */
async function remember(key: string, raster: ImageRaster): Promise<void> {
	const cap = await rasterCacheBytes();
	if (raster.packed.length > cap) {
		return;
	}

	const replaced = rasterCache.entries.get(key);
	if (replaced) {
		rasterCache.bytes -= replaced.packed.length;
	}

	rasterCache.entries.set(key, raster);
	rasterCache.bytes += raster.packed.length;

	for (const [oldest, evicted] of rasterCache.entries) {
		if (rasterCache.bytes <= cap) {
			break;
		}
		rasterCache.entries.delete(oldest);
		rasterCache.bytes -= evicted.packed.length;
	}
}

/**
 * Empties the raster cache, including anything being derived right now.
 *
 * For tests, which need to tell a hit from a miss and share one process across cases. Nothing in the
 * product calls it: an entry is keyed by the revision it came from, so there is never anything stale
 * to clear.
 *
 * A derivation already running is not cancelled — it finishes and stores its result, which is
 * harmless because the key it stores under is still the key that describes it.
 */
export function forgetRasters(): void {
	rasterCache.entries.clear();
	rasterCache.inFlight.clear();
	rasterCache.bytes = 0;
}

/**
 * What the raster cache is currently holding.
 *
 * For tests. The bound and the eviction it drives are invisible from the outside — a caller cannot
 * tell a cache that is accounting correctly from one whose counter has drifted, until it starts
 * evicting things it should have kept — so the accounting is asserted directly rather than inferred.
 *
 * @returns how many rasters are held and how many bytes of dots they come to
 */
export function rasterCacheStats(): { entries: number; bytes: number } {
	return { entries: rasterCache.entries.size, bytes: rasterCache.bytes };
}

/**
 * Reads a stored image's own dimensions.
 *
 * What an `<image>` tag needs at compile time, and deliberately all it needs: the raster it will
 * print as depends on the paper it is going to, so a job that has not chosen a printer yet has no
 * use for one. The dimensions are read from the row rather than by decoding the bytes, so measuring
 * a receipt does not decode every logo on it.
 *
 * @param name the asset's name, as written between the tags
 * @returns the image's size in pixels, as it was stored
 * @throws ApiError if no image of that name is stored, or the asset of that name is a font
 */
export async function storedImageSize(name: string): Promise<ImageSource> {
	const row = await prisma.asset.findUnique({
		where: { name },
		select: { kind: true, width: true, height: true },
	});
	if (!row) {
		throw new ApiError("unknown_asset", `There is no image called '${name}'.`);
	}
	requireImage(row.kind, name);
	if (row.width === null || row.height === null) {
		// Nullable because a font has no pixels, and that case is already refused above. Every IMAGE
		// this module writes has both, so a null here is a row it did not write — a fault to surface,
		// not a size to guess.
		throw new Error(`The stored image '${name}' has no dimensions`);
	}
	return { width: row.width, height: row.height };
}

/**
 * Refuses an asset that is not an image, to a caller that can only use one.
 *
 * `unknown_asset` rather than a code of its own: to an `<image>` tag, a name holding a font is a
 * name holding no image, which is the same situation as a name holding nothing. The sentence is what
 * differs, because "there is no image called 'x'" would send an operator looking for a missing
 * upload when the upload is sitting right there under that name.
 *
 * @param kind the kind the row holds
 * @param name the asset's name, for the refusal
 * @throws ApiError if it is not an image
 */
function requireImage(kind: string, name: string): void {
	if (kind !== "IMAGE") {
		throw new ApiError("unknown_asset", `'${name}' is a font, not an image.`);
	}
}

/**
 * How many parsed faces this process keeps.
 *
 * Small and fixed, unlike the raster cache's configurable byte budget, because the two are bounded
 * by different things. A face is held open for as long as glyphs are being rasterised from it, and
 * an install has a handful of fonts rather than a library of them — sixteen is more than any receipt
 * design would name and is bounded above by {@link maxFontBytes} times this, which an operator can
 * reason about without a setting for it.
 */
const MAX_CACHED_FACES = 16;

/**
 * Parsed faces, keyed by the asset revision they came from.
 *
 * Memoisation, not storage, exactly as the raster cache is: the bytes are what is stored, and an
 * entry here can always be rebuilt from them. The key carries the row's id *and* its `updatedAt`, so
 * a replaced font becomes unreachable rather than stale — the same invalidation story, and the same
 * reason there is no eviction on write to forget.
 *
 * Held on `globalThis` so a development hot reload does not strand the previous module's entries.
 */
const globalForFaces = globalThis as unknown as { fenposFaceCache: Map<string, FontFace> | undefined };

if (!globalForFaces.fenposFaceCache) {
	globalForFaces.fenposFaceCache = new Map();
}

const faceCache = globalForFaces.fenposFaceCache;

/**
 * Loads a stored font as a parsed face.
 *
 * **Memoised by asset revision.** Parsing walks the font's tables, and a face is asked for once per
 * run of text on every receipt naming it, so a compile of one document would otherwise re-parse the
 * same megabytes a dozen times. A cheap read of the row's id and timestamp happens on every call, so
 * a hit cannot serve glyphs from bytes that have been replaced.
 *
 * **The returned face is shared**, and `glyphs.ts` keys its own glyph cache on `id`, which is why
 * the id is the revision rather than the name: two revisions of one name must not be able to hand
 * each other's dots back.
 *
 * @param name the font's name, as markup refers to it
 * @returns the parsed face
 * @throws ApiError if no font of that name is stored, or the asset of that name is an image
 */
export async function fontFace(name: string): Promise<FontFace> {
	const row = await prisma.asset.findUnique({
		where: { name },
		select: { id: true, kind: true, data: true, updatedAt: true },
	});
	if (!row || row.kind !== "FONT") {
		// One sentence for both, because they are one situation to whoever wrote the markup: the name
		// they used does not name a font. Which of the two it is is visible on the Assets tab.
		throw new ApiError("unknown_font", `There is no font called '${name}'. Upload one on the Assets tab.`);
	}

	const key = `${row.id}:${row.updatedAt.getTime()}`;
	const remembered = faceCache.get(key);
	if (remembered) {
		// Re-inserted so the map's iteration order is least-recently-used first, which is the order
		// eviction walks.
		faceCache.delete(key);
		faceCache.set(key, remembered);
		return remembered;
	}

	// Not wrapped: these bytes parsed once already, on the way in. A failure now is this server
	// disagreeing with itself, which is a 500 and a log line, not something the caller did wrong.
	const face = parseFace(key, Buffer.from(row.data));

	faceCache.set(key, face);
	for (const oldest of faceCache.keys()) {
		if (faceCache.size <= MAX_CACHED_FACES) {
			break;
		}
		faceCache.delete(oldest);
	}

	return face;
}

/**
 * Empties the parsed-face cache.
 *
 * For tests, which need to tell a hit from a miss and share one process across cases. Nothing in the
 * product calls it: an entry is keyed by the revision it came from, so there is never anything stale
 * to clear.
 */
export function forgetFaces(): void {
	faceCache.clear();
}

/** A URL image as it was fetched: what it turned out to be, and the bytes it was measured from. */
export interface RemoteImage {
	width: number;
	height: number;
	/** The file exactly as fetched, so a caller that must also dither it need not fetch again. */
	bytes: Buffer;
}

/**
 * Fetches an image named by a URL and reads its dimensions, without storing it.
 *
 * The counterpart of {@link storedImageSize} for the live-URL half of the `<image>` tag, and the
 * reason both live in this module: the bytes go through {@link measured}, the same gate an upload
 * passes. A URL image is the only image here that no signed-in operator chose, so it must not be
 * the one that reaches a decoder unmeasured.
 *
 * **The bytes are handed back rather than dropped.** A URL image needs measuring *and* dithering
 * before its job can be compiled, and an earlier version of this returned only the size — so a print
 * fetched the same URL twice, once to measure and once for the pixels. The caller holds these for as
 * long as it takes to dither and no longer, which keeps the buffers in flight bounded by the
 * pre-pass's own resolve window rather than by how many URLs a receipt names.
 *
 * @param url the URL, exactly as it was written between the tags
 * @param settings pre-read, from `readRemoteFetchSettings`, so a caller resolving several images
 *        for one request need not have each call re-read the same settings; omit to read fresh
 * @returns the image's size in pixels and the bytes it was read from
 * @throws ApiError if the fetch is refused, or the bytes are not an image this pipeline prints
 */
export async function remoteImage(url: string, settings?: RemoteFetchSettings): Promise<RemoteImage> {
	const bytes = await fetchRemoteImage(url, settings ? { settings } : undefined);
	const decoded = await measured(bytes);
	return { width: decoded.width, height: decoded.height, bytes };
}

/**
 * The one way bytes become a stored asset.
 *
 * @param rawName the name as supplied
 * @param bytes the image
 * @param sourceUrl where it was fetched from, or null when uploaded
 * @returns the stored asset
 * @throws ApiError on any refusal
 */
async function store(rawName: string, bytes: Buffer, sourceUrl: string | null): Promise<AssetSummary> {
	const name = parseName(rawName);
	await requireNameFree(name);

	const decoded = await measured(bytes);

	let row: AssetRow;
	try {
		row = await prisma.asset.create({
			data: {
				kind: "IMAGE",
				name,
				// Copied into a plain `Uint8Array`: Prisma's `Bytes` will not take a `Buffer`, whose
				// backing store is typed as possibly shared. At most two megabytes, once, on upload.
				data: new Uint8Array(bytes),
				mimeType: decoded.mimeType,
				width: decoded.width,
				height: decoded.height,
				sourceUrl,
			},
			select: SUMMARY_COLUMNS,
		});
	} catch (thrown) {
		// `requireNameFree` and this insert are two statements, so two simultaneous creates of the
		// same name can both pass the check. The unique constraint on `name` is what keeps that
		// *correct*; this is only about how it reads. Without it the loser is told to check the
		// server log instead of being told the name is taken, which is the one thing they could
		// actually have done something about.
		if (!isPrismaCode(thrown, "P2002")) {
			throw thrown;
		}
		throw nameTaken(name, thrown);
	}

	logger.info("Asset stored", {
		assetId: row.id,
		name,
		kind: "IMAGE",
		mimeType: decoded.mimeType,
		width: decoded.width,
		height: decoded.height,
		bytes: bytes.length,
		sourceUrl,
	});

	return summarise(row);
}

/**
 * The one way font bytes become a stored asset.
 *
 * The parse is the validation, exactly as the decode is for an image: a file that opens with the
 * TrueType magic and holds nothing usable behind it is refused here, while whoever chose it is
 * still at the file picker, rather than at compile time on a receipt naming it.
 *
 * The parsed face is thrown away rather than seeded into the LRU. Its key carries the row's id and
 * `updatedAt`, neither of which exists yet at this point, and an upload is not evidence that
 * anything is about to print with it.
 *
 * @param rawName the name as supplied
 * @param bytes the font exactly as uploaded
 * @param mimeType what {@link detectAssetKind} read the flavour as
 * @returns the stored asset
 * @throws ApiError if the name is unusable or taken, the file is too large, or it will not parse
 */
async function storeFont(rawName: string, bytes: Buffer, mimeType: string): Promise<AssetSummary> {
	const name = parseName(rawName);
	await requireNameFree(name);

	await requireUsableFont(name, bytes);

	let row: AssetRow;
	try {
		row = await prisma.asset.create({
			data: {
				kind: "FONT",
				name,
				// Copied into a plain `Uint8Array` for the reason `store` gives.
				data: new Uint8Array(bytes),
				mimeType,
				// A font has no pixels. Left null rather than zeroed, so nothing downstream can read a
				// size out of a row that never had one.
				width: null,
				height: null,
				sourceUrl: null,
			},
			select: SUMMARY_COLUMNS,
		});
	} catch (thrown) {
		if (!isPrismaCode(thrown, "P2002")) {
			throw thrown;
		}
		throw nameTaken(name, thrown);
	}

	logger.info("Asset stored", { assetId: row.id, name, kind: "FONT", mimeType, bytes: bytes.length });

	return summarise(row);
}

/**
 * The one gate font bytes pass before anything here believes them.
 *
 * The byte cap runs first, so a file too large to store is refused before it is handed to a parser
 * that would walk its tables.
 *
 * The face this produces is dropped. It is parsed to find out whether it can be, and nothing
 * rasterises from it, so the id it is given here never reaches the glyph cache in `glyphs.ts` —
 * {@link fontFace} is what parses the face that does, under the revision's own key.
 *
 * @param name the asset's name, which the throwaway face is identified by
 * @param bytes the font, as uploaded
 * @throws ApiError if it is over {@link maxFontBytes}, or opentype cannot read it
 */
async function requireUsableFont(name: string, bytes: Buffer): Promise<void> {
	requireWithinBytes(bytes.length, await maxFontBytes());

	try {
		parseFace(name, bytes);
	} catch (thrown) {
		if (!(thrown instanceof InvalidFontError)) {
			throw thrown;
		}
		throw new ApiError("invalid_font", "This file could not be read as a TTF or OTF font.", {}, { cause: thrown });
	}
}

/**
 * The one gate bytes pass before anything here believes them.
 *
 * Every door into this module goes through it — an upload, a URL import, and the compile-time
 * measurement of a URL image — so a bound added here cannot be walked around by choosing another
 * door. The order is the load-bearing part: the size is read from the file's own header *before*
 * the decoder is handed the bytes, because the allocation being defended against happens inside the
 * decode. See `requireDecodableSize` in `lib/images/guard.ts`.
 *
 * The decode defences themselves live in that shared guard, under this module's caps; what stays
 * here is {@link requireProjectedHeight}, which is a decision about paper rather than about memory
 * and means nothing to a caller that is not printing. It runs **twice**, deliberately: once against
 * the size the header declares, before the guard is asked to decode anything, so an extreme-aspect
 * source never reaches the decoder; and once against the size the decoder reports, which is the
 * authority on what was really there.
 *
 * @param bytes the image, as uploaded or as fetched
 * @returns what the bytes turned out to be
 * @throws ApiError if they are too large, too big in pixels, or not a format this install currently
 *         accepts
 */
async function measured(bytes: Buffer): Promise<DecodedImage> {
	// Read once and used for both the early refusal below and the guard's own check, rather than
	// consulting the setting twice within one call and risking two different answers.
	const maxBytes = await maxAssetBytes();
	requireWithinBytes(bytes.length, maxBytes);

	// Before the decode, from the header alone. `measureImage` re-reads the header itself — this
	// call is not standing in for the guard's, it is here because the guard has no business knowing
	// about paper, and this bound has to be applied while the declared size is still all that has
	// been read.
	const declared = requireDecodableSize(bytes, MAX_IMAGE_DIMENSION);
	requireProjectedHeight(declared.width, declared.height);

	// The configured `assets.acceptedFormats`, not the pipeline's full baseline: this is the one
	// gate every new upload or import passes, so it is where narrowing the setting to PNG-only
	// actually bites. `ditherToRaster` (`derive`, below) re-renders bytes that already passed this
	// gate once and deliberately does not re-check it — see FORMAT_MIME_TYPES's doc comment.
	const acceptedFormats = FORMAT_MIME_TYPES[await enumSetting<AcceptedFormatsSetting>("assets.acceptedFormats")];

	const decoded = await measureImage(bytes, {
		maxBytes,
		maxDimension: MAX_IMAGE_DIMENSION,
		acceptedMimeTypes: acceptedFormats,
	});

	// Asset-only: a logo taller than the paper is a printing decision, not an image-safety one, so
	// it stays here rather than moving into the shared guard.
	requireProjectedHeight(decoded.width, decoded.height);

	return decoded;
}

/**
 * Refuses more bytes than the cap.
 *
 * Exported so the upload action can turn a file away from its declared size, before pulling it into
 * memory, and say the same thing this module would have said. The action's check is the early one;
 * the one inside `measureImage`, behind it, is the one that cannot be skipped. The sentence itself
 * is `requireWithinBytes`'s, so the two cannot drift apart.
 *
 * @param byteLength how many bytes the file is
 * @throws ApiError if that is beyond {@link maxAssetBytes}
 */
export async function requireWithinByteCap(byteLength: number): Promise<void> {
	requireWithinBytes(byteLength, await maxAssetBytes());
}

/**
 * Refuses a source too tall for its width to derive a raster from.
 *
 * **The bound {@link MAX_IMAGE_DIMENSION} does not give.** Every other check on this path bounds
 * the bytes that arrive or the pixels they decode to; none of them bounds the shape. `ditherToRaster`
 * resizes to the paper width preserving aspect, so the derived height is the aspect ratio times that
 * width, and the aspect ratio is inside all of 2 MB, 4096 per side, non-interlaced, and the JPEG
 * decode budget. A 1,106-byte 4x1024 PNG derives a 384x98,304 raster — measured at +439 MB resident
 * — and a 1x4096 source projects to about 7 GB.
 *
 * Refused here, at the one gate every door into this module passes, so a source like that never
 * enters the store. That matters more than the message: `rasterFor` re-derives from the stored bytes
 * on **every agent connect**, so one such row would be a denial of service that survives a restart,
 * and the `try/catch` around that derivation would not help because an out-of-memory abort is not
 * catchable. `ditherToRaster` refuses the same shape itself for rows that predate this check.
 *
 * Measured against {@link MAX_PAPER_DOTS} rather than any particular device's paper, so the answer
 * does not change when an install adds a wider printer to images it already accepted.
 *
 * @param width pixels across
 * @param height pixels down
 * @throws ApiError if the raster this would derive is taller than a raster may be
 */
function requireProjectedHeight(width: number, height: number): void {
	const projected = projectedHeightDots(width, height, MAX_PAPER_DOTS);
	if (projected > IMAGE_LIMITS.maxHeightDots) {
		throw new ApiError(
			"image_too_large",
			`This image is ${width}x${height}, which on the widest paper this system prints would come out ${projected} dots tall — more than the ${IMAGE_LIMITS.maxHeightDots} a raster can be. Crop it, or scale it down before uploading.`,
		);
	}
}

/**
 * Validates a name.
 *
 * @param rawName the name as supplied
 * @returns the name, trimmed
 * @throws ApiError if it is not slug-shaped, or is {@link RESERVED_ASSET_NAME}
 */
function parseName(rawName: string): string {
	const result = nameSchema.safeParse((rawName ?? "").trim());
	if (!result.success) {
		throw new ApiError("invalid_type", result.error.issues[0]?.message ?? "That name is not valid.", {
			field: "name",
		});
	}
	if (result.data === RESERVED_ASSET_NAME) {
		throw new ApiError(
			"invalid_type",
			`'${RESERVED_ASSET_NAME}' is reserved for the application's own logo and cannot be used for an asset.`,
			{ field: "name" },
		);
	}
	return result.data;
}

/**
 * Refuses a name already in use.
 *
 * Uniqueness is global rather than per kind, because markup names an asset by name alone: a font
 * and an image sharing `logo` would be two rows one reference could mean, and nothing written down
 * would say which.
 *
 * @param name the candidate name
 * @throws ApiError if an asset of that name is already stored, whatever kind it is
 */
async function requireNameFree(name: string): Promise<void> {
	const clash = await prisma.asset.findUnique({ where: { name }, select: { id: true } });
	if (clash) {
		throw nameTaken(name, undefined);
	}
}

/**
 * The refusal for a name already in use.
 *
 * One function because there are two ways to find out — the check before the insert, and the
 * unique constraint catching the race the check cannot — and an operator should not be able to tell
 * which one they hit.
 *
 * @param name the name that was taken
 * @param cause the Prisma error, when the constraint was what reported it
 * @returns the error to throw
 */
function nameTaken(name: string, cause: unknown): ApiError {
	return new ApiError("name_taken", `There is already an asset called '${name}'.`, { field: "name" }, { cause });
}

/**
 * Whether an error is Prisma reporting a particular condition.
 *
 * Matched on the code rather than the message so a wording change upstream cannot silently turn
 * this into a swallowed unrelated failure. Same shape as `isMissingRecordError` in
 * `lib/agents/pairing.ts`; duck-typed rather than an `instanceof`, because the error class lives in
 * the generated client and importing it here to test one string would be a heavier coupling than
 * the check is worth.
 *
 * @param error the caught value
 * @param code the Prisma error code to match, e.g. P2002 or P2025
 * @returns true when the error carries that code
 */
function isPrismaCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * Converts a row into what the panel renders.
 *
 * `width` and `height` are carried through as they are, null included: a font has no pixels, and a
 * zero would be read as a real size by anything that did arithmetic with it. Every IMAGE this
 * module writes has both, so a null on one of those is a row it did not write.
 *
 * Exported so `GET /api/v1/assets` can build its listing from it instead of re-implementing the
 * `kind` narrowing: without it a listing built straight from the columns would emit an un-narrowed
 * `kind` against a schema that declares it a closed enum.
 *
 * @param row the selected columns
 * @returns the summary
 */
export function summarise(row: AssetRow): AssetSummary {
	return {
		id: row.id,
		kind: AssetKind.is(row.kind) ? row.kind : "IMAGE",
		name: row.name,
		width: row.width,
		height: row.height,
		mimeType: row.mimeType,
		sourceUrl: row.sourceUrl,
		createdAt: row.createdAt.toISOString(),
	};
}
