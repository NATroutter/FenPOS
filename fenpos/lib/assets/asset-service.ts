import "server-only";
import { decodeImage, ditherToRaster, ImageDecodeError, type ImageRaster } from "@/lib/assets/dither";
import { fetchRemoteImage, safeUrl } from "@/lib/assets/fetch-remote";
import { prisma } from "@/lib/db";
import { AssetKind } from "@/lib/domain/enums";
import { nameSchema } from "@/lib/domain/naming";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * The image library a receipt's `<image>` tag draws from.
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
 * Two entry points put bytes into this table — an upload and a URL import — and both go through
 * {@link store}, so a bound added here cannot be walked around by choosing the other door.
 */

/**
 * The largest asset this system will store, in bytes.
 *
 * Two megabytes — the same figure the remote fetch streams up to in `MAX_REMOTE_IMAGE_BYTES`, so an
 * upload and an import turn away the same file, and this one still decides for both because both go
 * through {@link store}. Stated here rather than left to Next's server-action body limit: a limit
 * inherited from a framework default is one nobody can find, and upgrading the framework would
 * silently change the product. `next.config.ts` raises its own ceiling above this on purpose, so
 * that this constant is what actually decides.
 *
 * This bounds the bytes that arrive. It does not bound what they decode to — see
 * {@link MAX_IMAGE_DIMENSION}, which is the bound that matters.
 */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

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
 * At the worst case it permits, 4096x4096, the decoded bitmap is 64 MB and the process reached
 * 147 MB resident; measured, on the same machine as the figures above. That is a cost a shop's
 * server can absorb, and everything past it is either a mistake or an attack.
 *
 * Checked from the file's header rather than from the decoded image, because a check that runs
 * after `decodeImage` runs after the allocation it exists to prevent. See {@link declaredSize}.
 *
 * That 4096x4096 worst case holds only because {@link requireDecodableSize} also refuses
 * interlaced PNGs. Without that refusal this number bounds nothing at all, for reasons written out
 * there — it is not an independent limit, and the two have to be read together.
 */
export const MAX_IMAGE_DIMENSION = 4096;

/** An asset as the Assets tab lists it. Deliberately without the bytes. */
export interface AssetSummary {
	id: string;
	kind: AssetKind;
	name: string;
	width: number;
	height: number;
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
 * Lists every stored asset.
 *
 * @returns assets ordered by name, without their bytes
 */
export async function listAssets(): Promise<AssetSummary[]> {
	const rows = await prisma.asset.findMany({ orderBy: { name: "asc" }, select: SUMMARY_COLUMNS });
	return rows.map(summarise);
}

/**
 * Stores an uploaded image.
 *
 * @param name what markup will refer to it by; slug-shaped
 * @param bytes the file exactly as uploaded
 * @returns the stored asset
 * @throws ApiError if the name is unusable or taken, the file is too large, too big in pixels, or
 *         not an image this pipeline prints
 */
export async function createAsset(name: string, bytes: Buffer): Promise<AssetSummary> {
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
		throw new ApiError("unknown_asset", "That image no longer exists.");
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
		throw new ApiError("unknown_asset", "That image no longer exists.", {}, { cause: thrown });
	}

	logger.info("Asset deleted", { assetId: id, name: existing.name });
}

/**
 * Renders a stored image as a 1-bit raster for a given paper width.
 *
 * Derived on every call rather than cached. Dithering half a megapixel is real work, so this is not
 * for the print path — the print path resolves an image while compiling, not while printing. If a
 * cache ever becomes necessary it belongs in its own table keyed by asset and width, never in
 * `Asset.data`, which holds the source and must keep holding the source.
 *
 * @param name the asset's name
 * @param targetDots the paper width in printer dots, from `dotWidth(columns)`
 * @returns the raster's size in dots and its packed bits, MSB first
 * @throws ApiError if no image of that name is stored
 * @throws RangeError if `targetDots` is not a positive whole number of dots
 */
export async function rasterFor(name: string, targetDots: number): Promise<ImageRaster> {
	const row = await prisma.asset.findUnique({
		where: { kind_name: { kind: "IMAGE", name } },
		select: { data: true },
	});
	if (!row) {
		throw new ApiError("unknown_asset", `There is no image called '${name}'.`);
	}

	// Not wrapped: these bytes decoded once already, on the way in. A failure now is this server
	// disagreeing with itself, which is a 500 and a log line, not something the caller did wrong.
	return ditherToRaster(Buffer.from(row.data), targetDots);
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

	requireWithinByteCap(bytes.length);
	requireDecodableSize(bytes);

	let decoded: Awaited<ReturnType<typeof decodeImage>>;
	try {
		decoded = await decodeImage(bytes);
	} catch (thrown) {
		if (thrown instanceof ImageDecodeError) {
			// The decoder's message is already written for whoever chose the file. Re-raised as an
			// ApiError so the panel shows it, instead of the action's catch-all turning a bad
			// upload into "something went wrong, check the server log".
			throw new ApiError("invalid_type", thrown.message, {}, { cause: thrown });
		}
		throw thrown;
	}

	// Belt and braces: the header said one thing, the decoder is the authority on what was really
	// there. They agree for every well-formed file, and where they do not the smaller claim was the
	// one that got past the gate.
	requireWithinDimensions(decoded.width, decoded.height);

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
		// same name can both pass the check. The `@@unique([kind, name])` constraint is what keeps
		// that *correct*; this is only about how it reads. Without it the loser is told to check
		// the server log instead of being told the name is taken, which is the one thing they could
		// actually have done something about.
		if (!isPrismaCode(thrown, "P2002")) {
			throw thrown;
		}
		throw nameTaken(name, thrown);
	}

	logger.info("Asset stored", {
		assetId: row.id,
		name,
		mimeType: decoded.mimeType,
		width: decoded.width,
		height: decoded.height,
		bytes: bytes.length,
		sourceUrl,
	});

	return summarise(row);
}

/**
 * Refuses more bytes than the cap.
 *
 * Exported so the upload action can turn a file away from its declared size, before pulling it into
 * memory, and say the same thing this module would have said. The action's check is the early one;
 * this one, behind it, is the one that cannot be skipped.
 *
 * @param byteLength how many bytes the file is
 * @throws ApiError if that is beyond {@link MAX_ASSET_BYTES}
 */
export function requireWithinByteCap(byteLength: number): void {
	if (byteLength > MAX_ASSET_BYTES) {
		const cap = Math.floor(MAX_ASSET_BYTES / 1024 / 1024);
		throw new ApiError(
			"body_too_large",
			`An image must be at most ${cap} MB; this one is ${(byteLength / 1024 / 1024).toFixed(1)} MB.`,
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
 * @throws ApiError if the size cannot be read, the PNG is interlaced, or either side is beyond
 *         {@link MAX_IMAGE_DIMENSION}
 */
function requireDecodableSize(bytes: Buffer): void {
	const declared = declaredSize(bytes);
	if (!declared) {
		throw new ApiError("invalid_type", "Images must be PNG or JPEG.");
	}
	if (declared.interlaced) {
		// Checked before the dimensions, because for an interlaced PNG the dimensions are exactly
		// the thing that has stopped being true.
		throw new ApiError(
			"invalid_type",
			"Interlaced (Adam7) PNGs are not accepted. Save this image without interlacing and upload it again.",
		);
	}
	requireWithinDimensions(declared.width, declared.height);
}

/**
 * Refuses a size beyond the cap.
 *
 * @param width pixels across
 * @param height pixels down
 * @throws ApiError if either side is beyond {@link MAX_IMAGE_DIMENSION}
 */
function requireWithinDimensions(width: number, height: number): void {
	if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
		throw new ApiError(
			"invalid_type",
			`An image must be at most ${MAX_IMAGE_DIMENSION} pixels on each side; this one is ${width}x${height}.`,
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

/** An image's own account of itself, read from its header rather than from a decoded bitmap. */
interface DeclaredImage {
	width: number;
	height: number;
	/** Adam7. PNG only, and the one flag that makes the two dimensions above stop meaning anything. */
	interlaced: boolean;
}

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

/**
 * Validates a name.
 *
 * @param rawName the name as supplied
 * @returns the name, trimmed
 * @throws ApiError if it is not slug-shaped
 */
function parseName(rawName: string): string {
	const result = nameSchema.safeParse((rawName ?? "").trim());
	if (!result.success) {
		throw new ApiError("invalid_type", result.error.issues[0]?.message ?? "That name is not valid.", {
			field: "name",
		});
	}
	return result.data;
}

/**
 * Refuses a name already in use.
 *
 * Uniqueness is per kind rather than global, so a later asset kind may reuse a name that reads
 * naturally for it without colliding with an image.
 *
 * @param name the candidate name
 * @throws ApiError if an image of that name is already stored
 */
async function requireNameFree(name: string): Promise<void> {
	const clash = await prisma.asset.findUnique({
		where: { kind_name: { kind: "IMAGE", name } },
		select: { id: true },
	});
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
	return new ApiError("name_taken", `There is already an image called '${name}'.`, { field: "name" }, { cause });
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
 * `width` and `height` are nullable in the schema, for a future kind that is not a raster. Every
 * IMAGE has both, so a null here would mean a row this module did not write.
 *
 * @param row the selected columns
 * @returns the summary
 */
function summarise(row: AssetRow): AssetSummary {
	return {
		id: row.id,
		kind: AssetKind.is(row.kind) ? row.kind : "IMAGE",
		name: row.name,
		width: row.width ?? 0,
		height: row.height ?? 0,
		mimeType: row.mimeType,
		sourceUrl: row.sourceUrl,
		createdAt: row.createdAt.toISOString(),
	};
}
