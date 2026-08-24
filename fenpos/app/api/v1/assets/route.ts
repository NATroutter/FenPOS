import { z } from "zod";
import { assertCursorInFilter, pageOf, readPageParams } from "@/lib/api/pagination";
import { createAsset, importAssetFromUrl, maxAssetBytes } from "@/lib/assets/asset-service";
import { requireApiRead } from "@/lib/auth/rate-limit";
import { prisma } from "@/lib/db";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { authenticateKey, requirePermission } from "@/lib/keys/authenticate";
import { logger } from "@/lib/logger";

/**
 * `GET` and `POST /api/v1/assets` — the stored images markup refers to by name.
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

/** The create body: a name, and exactly one source for the bytes. */
const createSchema = z.object({
	name: z.string(),
	data: z.string().optional(),
	url: z.string().optional(),
});

export async function GET(request: Request): Promise<Response> {
	try {
		const key = await authenticateKey(request);
		requirePermission(key, "assets:read");

		await requireApiRead(key.id);

		const { take, cursor } = await readPageParams(new URL(request.url));

		// Assets are install-wide — there is no per-key `where` to compose here, unlike the jobs
		// listing — so this only has to confirm the cursor names a row at all. See
		// `assertCursorInFilter`'s own doc comment for why a cursor naming nothing must be refused
		// rather than silently answered with a short page.
		if (cursor !== null) {
			await assertCursorInFilter(cursor, () => prisma.asset.findFirst({ where: { id: cursor }, select: { id: true } }));
		}

		// `listAssets()` is not used here because it returns everything: on an install with hundreds
		// of images that is a page this endpoint cannot bound. The columns are the same ones it
		// selects, and `data` is excluded for the same reason — a listing must not be as large as the
		// images it describes.
		const rows = await prisma.asset.findMany({
			orderBy: [{ name: "asc" }, { id: "asc" }],
			take: take + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: SUMMARY_COLUMNS,
		});

		const { page, nextCursor } = pageOf(rows, take);

		return Response.json({
			assets: page.map((row) => ({
				name: row.name,
				kind: row.kind,
				width: row.width,
				height: row.height,
				mimeType: row.mimeType,
				sourceUrl: row.sourceUrl,
				createdAt: row.createdAt.toISOString(),
			})),
			nextCursor,
		});
	} catch (error) {
		return toErrorResponse(error, { route: "GET /api/v1/assets" });
	}
}

export async function POST(request: Request): Promise<Response> {
	try {
		const key = await authenticateKey(request);
		requirePermission(key, "assets:write");

		const { name, data, url } = await readCreate(request);

		const asset = data === undefined ? await importAssetFromUrl(name, url as string) : await storeUpload(name, data);

		logger.info("Asset stored through the API", { keyId: key.id, name: asset.name, imported: data === undefined });

		return Response.json(asset, { status: 201 });
	} catch (error) {
		return toErrorResponse(error, { route: "POST /api/v1/assets" });
	}
}

/**
 * Decodes an inline upload and stores it.
 *
 * The length is checked before `createAsset` sees the buffer so that an oversized upload is refused
 * without a decode — the same ordering the print endpoint uses on its body, and for the same reason:
 * decoding is the work an oversized request is trying to provoke.
 *
 * @param name what markup will refer to it by
 * @param data the file, base64 encoded
 * @returns the stored asset
 * @throws ApiError when the payload is over the configured cap, or is not an image this pipeline prints
 */
async function storeUpload(name: string, data: string): Promise<Awaited<ReturnType<typeof createAsset>>> {
	const bytes = Buffer.from(data, "base64");

	const cap = await maxAssetBytes();
	if (bytes.byteLength > cap) {
		throw new ApiError("body_too_large", `An asset may be at most ${cap} bytes; this one is ${bytes.byteLength}.`, {
			bytes: bytes.byteLength,
			limit: cap,
		});
	}

	return await createAsset(name, bytes);
}

/**
 * Reads a create request.
 *
 * @param request the incoming request
 * @returns the name, and exactly one of the two sources
 * @throws ApiError when the body is not JSON, names no source, or names both
 */
async function readCreate(request: Request): Promise<{ name: string; data?: string; url?: string }> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new ApiError("invalid_json", "Body is not valid JSON");
	}

	const parsed = createSchema.safeParse(body);
	if (!parsed.success) {
		throw new ApiError("missing_field", "Body must carry 'name', and one of 'data' or 'url'.");
	}

	const { name, data, url } = parsed.data;

	if (data === undefined && url === undefined) {
		throw new ApiError("missing_field", "Provide the image as base64 in 'data', or a URL in 'url'.");
	}
	if (data !== undefined && url !== undefined) {
		// Refused rather than resolved by precedence. A body carrying both states no intention, and a
		// rule about which wins would silently store the one the caller did not mean.
		throw new ApiError("invalid_type", "Provide 'data' or 'url', not both.");
	}

	return { name, data, url };
}
