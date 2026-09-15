import { z } from "zod";
import { apiRoute } from "@/lib/api/api-route";
import { readBoundedJson } from "@/lib/api/bounded-body";
import { assertCursorInFilter, pageOf, readPageParams } from "@/lib/api/pagination";
import {
	type AssetSummary,
	createAsset,
	importAssetFromUrl,
	maxAssetBytes,
	maxFontBytes,
	summarise,
} from "@/lib/assets/asset-service";
import { requireApiRead } from "@/lib/auth/rate-limit";
import { prisma } from "@/lib/db";
import { AssetKind } from "@/lib/domain/enums";
import { MAX_NAME_LENGTH } from "@/lib/domain/naming";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * `GET` and `POST /api/v1/assets` — the stored images and fonts markup refers to by name.
 *
 * One namespace over both kinds, and `POST` reads which it is from the bytes rather than from
 * anything the body says. A URL import is images only: the fetcher measures what it brings back, and
 * a font is not something it can measure.
 *
 * **Assets are install-wide, not scoped to a key's devices.** They already are: the panel, the
 * markup resolver and every key see one namespace, and an `<image>` tag naming one resolves the same
 * way whoever submitted it. Scoping them per key now would split that namespace and break the
 * panel's view of it, so `assets:write` is a broader grant than any device permission — which is
 * what its description in `permissions.ts` says, and why an operator should read it before ticking.
 *
 * Two doors for creating one, the same two the Assets tab offers: bytes inline, or a URL to import
 * from. Exactly one, because a body carrying both cannot be resolved into an intention — and
 * guessing which the caller meant is how the wrong logo ends up on a receipt.
 *
 * Neither handler validates images or names itself. `asset-service.ts` owns that — the decode
 * bounds, the slug shape, the reserved bundled-logo name, the duplicate check — and raises the
 * `ApiError`s that reach the caller. Restating any of it here would be a second opinion able to
 * disagree with the first.
 *
 * **Neither handler publishes the row id.** `GET` lists by name, `POST` answers with the same shape
 * it lists — one asset type, not two — for the reason `DELETE /assets/{name}`'s own comment gives:
 * the id is not what markup or a caller names an asset by, and publishing it would be a second way
 * to name the same thing that integrators would then depend on.
 */

/** Never cached: an asset uploaded a moment ago must appear. */
export const dynamic = "force-dynamic";

/** The columns a listing returns. `data` is deliberately absent — see `GET`'s comment. */
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

/** The kinds this build can describe, as a Prisma filter. */
const KNOWN_KINDS: { in: string[] } = { in: [...AssetKind.values] };

/** The create body: a name, and exactly one source for the bytes. */
const createSchema = z.object({
	name: z.string(),
	data: z.string().optional(),
	url: z.string().optional(),
});

export const GET = apiRoute("api:GET /v1/assets", async ({ key, request }) => {
	await requireApiRead(key.id);

	const { take, cursor } = await readPageParams(new URL(request.url));

	// Assets are install-wide — there is no per-key `where` to compose here, unlike the jobs
	// listing — but the query below is filtered to the kinds this build knows, so the cursor has to
	// be checked against that same filter: a cursor naming a row of some other kind would otherwise
	// pass this guard while never appearing in the listing it is meant to resume. See
	// `assertCursorInFilter`'s own doc comment for why a cursor naming nothing must be refused
	// rather than silently answered with a short page.
	if (cursor !== null) {
		await assertCursorInFilter(cursor, () =>
			prisma.asset.findFirst({ where: { id: cursor, kind: KNOWN_KINDS }, select: { id: true } }),
		);
	}

	// `listAssets()` is not used here because it returns everything: on an install with hundreds
	// of assets that is a page this endpoint cannot bound. The columns are the same ones it
	// selects, and `data` is excluded for the same reason — a listing must not be as large as the
	// files it describes.
	//
	// Filtered to the kinds `AssetKind` names, which is every kind this build can write. A row of
	// some other kind would be described by `summarise`'s fallback as an image, which would be a
	// lie about a row nothing here wrote.
	const rows = await prisma.asset.findMany({
		where: { kind: KNOWN_KINDS },
		// Ascending by name, not newest-first like the jobs listing — an asset library is browsed
		// alphabetically, the way the Assets tab presents it, rather than by when each asset was
		// added.
		orderBy: [{ name: "asc" }, { id: "asc" }],
		take: take + 1,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		select: SUMMARY_COLUMNS,
	});

	const { page, nextCursor } = pageOf(rows, take);

	return {
		response: Response.json({
			// `summarise` rather than a second, hand-rolled mapping: it is the one place that coerces a
			// nullable `width`/`height` to the integers the OpenAPI schema declares required and narrows
			// `kind` to the closed enum, so this listing cannot describe a row differently than the rest
			// of this module does.
			assets: page.map((row) => toPublicAsset(summarise(row))),
			nextCursor,
		}),
		// No target: an asset belongs to the install rather than to any one printer, which is this
		// module's whole first paragraph.
		message: `Listed ${page.length} assets`,
	};
});

export const POST = apiRoute("api:POST /v1/assets", async ({ key, request }) => {
	const { name, data, url } = await readCreate(request);

	const asset = data === undefined ? await importAssetFromUrl(name, url as string) : await storeUpload(name, data);

	logger.info("Asset stored through the API", {
		keyId: key.id,
		name: asset.name,
		kind: asset.kind,
		imported: data === undefined,
	});

	return {
		response: Response.json(toPublicAsset(asset), { status: 201 }),
		// Which door it came through, because the two fail in different places and an operator
		// reconciling a missing asset needs to know which one to look at.
		message: `Stored asset '${asset.name}' ${data === undefined ? "imported from a URL" : "from an upload"}`,
	};
});

/**
 * Strips the row id `asset-service.ts` carries for the panel's own use.
 *
 * The one place both handlers narrow to the shape the API actually publishes, so `GET` and `POST`
 * cannot drift into answering with two different asset types for one resource — see this module's
 * own doc comment for why the id itself is never one of the fields.
 *
 * @param asset the summary as `asset-service.ts` returns it
 * @returns the same summary, without `id`
 */
function toPublicAsset(asset: AssetSummary): Omit<AssetSummary, "id"> {
	const { id: _id, ...rest } = asset;
	return rest;
}

/**
 * Decodes an inline upload and stores it.
 *
 * The size cap is enforced by `createAsset` alone rather than restated here. `asset-service.ts`'s
 * `measured` still refuses an oversized file before anything decodes it — through
 * `requireWithinBytes`, the shared guard's own check, which is what the module's former
 * `requireWithinByteCap` became when the decode defences moved to `lib/images/guard.ts` — so
 * "refused before it is decoded" holds exactly as before. The refusal's message is `describeBytes`'s,
 * the one form every caller of that module is required to use on both halves of the sentence (see
 * that function's own doc comment), rather than a second, raw-byte-count wording that a route-level
 * pre-check would have needed to keep in step with it by hand.
 *
 * @param name what markup will refer to it by
 * @param data the file, base64 encoded
 * @returns the stored asset
 * @throws ApiError when the payload is over the configured cap, or is neither an image this pipeline
 *         prints nor a font it can read
 */
async function storeUpload(name: string, data: string): Promise<Awaited<ReturnType<typeof createAsset>>> {
	return await createAsset(name, Buffer.from(data, "base64"));
}

/**
 * How large a create-asset body may be before it is parsed.
 *
 * `measured` inside `createAsset` still enforces the real limit, through `requireWithinBytes` — this
 * exists only to refuse a body too large to be a legitimate request before `JSON.parse` (and, on the
 * upload branch, a base64 decode) does the work of parsing it, so it is deliberately generous
 * rather than exact.
 *
 * The body wraps the file as base64 in JSON, so the ceiling this route reads up to has to cover
 * both inflations: base64 turns 3 bytes into 4 characters, a 4/3 expansion of the byte cap, and the
 * envelope wraps that string in `{"name":"…","data":"…"}` — two field names, their quoting, the
 * object's own punctuation, and a name up to {@link MAX_NAME_LENGTH} characters. 512 bytes of
 * headroom past the base64 expansion and the longest legal name covers all of that with room to
 * spare.
 *
 * **The larger of the image and font caps**, because nothing here can tell the two apart yet: the
 * kind is read from the bytes, and the bytes are inside the body this bound decides whether to read.
 * Sized to the image cap alone, a font under `assets.maxFontUploadMb` but over `assets.maxUploadMb`
 * would be refused as an oversized body — a refusal naming a limit that does not apply to it. The
 * kind's own cap is then applied by `createAsset`, which is where it means something.
 *
 * A `url` import's body is far smaller than this, but the bound is checked before the body is
 * parsed — before either branch can be told apart — so all of them read up to the same ceiling,
 * sized for the largest.
 *
 * @returns the byte ceiling this route reads a create body up to
 */
async function maxCreateAssetBodyBytes(): Promise<number> {
	const fileCap = Math.max(await maxAssetBytes(), await maxFontBytes());
	return Math.ceil((fileCap * 4) / 3) + 512 + MAX_NAME_LENGTH;
}

/**
 * Reads a create request.
 *
 * @param request the incoming request
 * @returns the name, and exactly one of the two sources
 * @throws ApiError when the body is too large, not JSON, names no source, or names both
 */
async function readCreate(request: Request): Promise<{ name: string; data?: string; url?: string }> {
	const { body } = await readBoundedJson(request, await maxCreateAssetBodyBytes());

	const parsed = createSchema.safeParse(body);
	if (!parsed.success) {
		throw new ApiError("missing_field", "Body must carry 'name', and one of 'data' or 'url'.");
	}

	const { name, data, url } = parsed.data;

	if (data === undefined && url === undefined) {
		throw new ApiError("missing_field", "Provide the image or font as base64 in 'data', or an image URL in 'url'.");
	}
	if (data !== undefined && url !== undefined) {
		// Refused rather than resolved by precedence. A body carrying both states no intention, and a
		// rule about which wins would silently store the one the caller did not mean.
		throw new ApiError("invalid_type", "Provide 'data' or 'url', not both.");
	}

	return { name, data, url };
}
