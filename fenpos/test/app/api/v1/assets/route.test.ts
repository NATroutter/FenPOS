import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiReadLimiter } from "@/lib/auth/rate-limit";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

/**
 * `GET` and `POST /api/v1/assets` — stored images, without a browser.
 *
 * The import path is mocked at `importAssetFromUrl` rather than at the network, because what this
 * file is about is the route: the permission, the two mutually exclusive body shapes, and the
 * reserved name. What a URL import does to the network is `fetch-remote.test.ts`'s subject and is
 * thoroughly covered there.
 */
vi.mock("@/lib/assets/asset-service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/assets/asset-service")>();
	return { ...actual, importAssetFromUrl: vi.fn(actual.importAssetFromUrl) };
});

const { GET, POST } = await import("@/app/api/v1/assets/route");
const { importAssetFromUrl } = await import("@/lib/assets/asset-service");

const PNG = readFileSync("test/fixtures/logo.png");

let token: string;
let keyId: string;

/**
 * @param body the JSON body to post
 * @returns a POST request carrying the granted credential
 */
function post(body: unknown): Request {
	return new Request("https://fenpos.test/api/v1/assets", {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
}

/**
 * @param query the query string, without the leading `?`
 * @returns a GET request carrying the granted credential
 */
function get(query = ""): Request {
	return new Request(`https://fenpos.test/api/v1/assets${query ? `?${query}` : ""}`, {
		headers: { authorization: `Bearer ${token}` },
	});
}

beforeEach(async () => {
	vi.mocked(importAssetFromUrl).mockClear();

	await prisma.asset.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.setting.deleteMany();

	token = `fp_${Date.now()}_${Math.random()}`;
	const key = await prisma.apiKey.create({
		data: {
			name: "deploy",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "assets:read" }, { permission: "assets:write" }] },
		},
	});
	keyId = key.id;
	apiReadLimiter.reset(key.id);
});

describe("POST /api/v1/assets", () => {
	it("stores an uploaded image", async () => {
		const response = await POST(post({ name: "shop-logo", data: PNG.toString("base64") }));
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.name).toBe("shop-logo");
		expect(body.width).toBeGreaterThan(0);
		expect(await prisma.asset.count()).toBe(1);
	});

	it("refuses an oversized body before it is parsed", async () => {
		// Comfortably over the envelope this route derives from the default 2 MiB `assets.maxUploadMb`
		// (base64's 4/3 expansion plus headroom is about 2.8 MB) while still being valid JSON, so a
		// failure here can only be the size check that runs before `JSON.parse` and the base64 decode
		// it guards — not a parse failure, which would prove nothing about the ordering.
		const response = await POST(post({ name: "huge", data: "x".repeat(3_000_000) }));

		expect(response.status).toBe(413);
		expect((await response.json()).error).toBe("body_too_large");
		expect(await prisma.asset.count()).toBe(0);
	});

	// The row id is `asset-service.ts`'s own concern — the panel's Assets tab uses it to address a
	// rename or a replace — but nothing in the public API accepts one back: markup and `DELETE
	// /assets/{name}` both address an asset by the name the caller chose. Publishing it here would
	// be a second way to name the same resource that an integrator could come to depend on.
	it("does not publish the row id", async () => {
		const response = await POST(post({ name: "shop-logo", data: PNG.toString("base64") }));
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body).not.toHaveProperty("id");
	});

	it("imports an image from a URL", async () => {
		vi.mocked(importAssetFromUrl).mockResolvedValueOnce({
			id: "asset-1",
			name: "remote-logo",
			mimeType: "image/png",
			width: 128,
			height: 40,
			bytes: PNG.length,
			sourceUrl: "https://cdn.test/logo.png",
			createdAt: new Date().toISOString(),
		} as never);

		const response = await POST(post({ name: "remote-logo", url: "https://cdn.test/logo.png" }));

		expect(response.status).toBe(201);
		expect(vi.mocked(importAssetFromUrl)).toHaveBeenCalledWith("remote-logo", "https://cdn.test/logo.png");
	});

	it("refuses a body naming neither data nor url", async () => {
		const response = await POST(post({ name: "nothing" }));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("missing_field");
	});

	it("refuses a body naming both, because it cannot mean both", async () => {
		const response = await POST(post({ name: "both", data: PNG.toString("base64"), url: "https://cdn.test/x.png" }));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_type");
	});

	it("refuses data that is not base64 of an image", async () => {
		const response = await POST(post({ name: "junk", data: "bm90LWFuLWltYWdl" }));

		expect(response.status).toBe(422);
		expect((await response.json()).error).toBe("invalid_image");
	});

	it("refuses the reserved name the bundled logo uses", async () => {
		const { RESERVED_ASSET_NAME } = await import("@/lib/assets/asset-service");

		const response = await POST(post({ name: RESERVED_ASSET_NAME, data: PNG.toString("base64") }));

		// `invalid_type`, not a conflict: the name is unusable rather than occupied, and
		// `asset-service.ts`'s `parseName` already says so in exactly these terms. The route adds no
		// code of its own for this — it lets the service's refusal through.
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_type");
		expect(await prisma.asset.count()).toBe(0);
	});

	it("refuses a name already taken", async () => {
		await POST(post({ name: "shop-logo", data: PNG.toString("base64") }));
		const response = await POST(post({ name: "shop-logo", data: PNG.toString("base64") }));

		expect(response.status).toBe(409);
		expect((await response.json()).error).toBe("name_taken");
		expect(await prisma.asset.count()).toBe(1);
	});

	it("refuses a key holding only assets:read", async () => {
		await prisma.apiKeyPermission.deleteMany({ where: { apiKeyId: keyId, permission: "assets:write" } });

		expect((await POST(post({ name: "x", data: PNG.toString("base64") }))).status).toBe(403);
	});
});

describe("GET /api/v1/assets", () => {
	it("lists stored assets without their bytes", async () => {
		await POST(post({ name: "shop-logo", data: PNG.toString("base64") }));

		const body = await (await GET(get())).json();

		expect(body.assets).toHaveLength(1);
		expect(body.assets[0].name).toBe("shop-logo");
		// The bytes are what markup references by name; shipping them in a listing would make every
		// page of this endpoint as large as the images it describes.
		expect(body.assets[0]).not.toHaveProperty("data");
	});

	it("orders by name ascending, not by creation time", async () => {
		for (const name of ["zebra-logo", "apple-logo", "mango-logo"]) {
			await POST(post({ name, data: PNG.toString("base64") }));
		}

		const body = await (await GET(get())).json();

		expect(body.assets.map((asset: { name: string }) => asset.name)).toEqual([
			"apple-logo",
			"mango-logo",
			"zebra-logo",
		]);
	});

	// Not reachable through the public API — `createAsset` always writes `width`/`height` from the
	// decoded image — so the row is inserted directly, standing in for what a future non-raster
	// `AssetKind` might leave null. This is what proves the listing goes through the same
	// `summarise` every other asset shape does, rather than a second, hand-rolled mapping that
	// forgot the coercion the OpenAPI schema's required integers depend on.
	it("coerces a null width/height to the integers the schema declares", async () => {
		await prisma.asset.create({
			data: { kind: "IMAGE", name: "raw-row", data: Buffer.alloc(1), mimeType: "image/png", width: null, height: null },
		});

		const body = await (await GET(get())).json();
		const raw = body.assets.find((asset: { name: string }) => asset.name === "raw-row");

		expect(raw).toBeDefined();
		expect(raw.width).toBe(0);
		expect(raw.height).toBe(0);
	});

	// `kind` on the Prisma model is a plain `String`, not a database enum — the schema comment on
	// `Asset.kind` says the closed set is application-level only, guarding against a future kind
	// reusing a name the way `DELETE /assets/{name}` already addresses rows by `kind_name`. Nothing in
	// today's API can create a row of any kind but "IMAGE", so — like the null width/height row above
	// — this one is inserted directly to stand in for that future row.
	it("does not list an asset of a kind other than IMAGE", async () => {
		await prisma.asset.create({
			data: {
				kind: "STICKER",
				name: "future-kind",
				data: Buffer.alloc(1),
				mimeType: "image/png",
				width: null,
				height: null,
			},
		});

		const body = await (await GET(get())).json();

		expect(body.assets.find((asset: { name: string }) => asset.name === "future-kind")).toBeUndefined();
		// Confirms the row is really there, so this cannot pass merely because the insert failed.
		expect(await prisma.asset.findMany({ where: { name: "future-kind" } })).toHaveLength(1);
	});

	it("pages with a cursor", async () => {
		for (const name of ["a-logo", "b-logo", "c-logo"]) {
			await POST(post({ name, data: PNG.toString("base64") }));
		}

		const first = await (await GET(get("limit=2"))).json();
		expect(first.assets).toHaveLength(2);

		const second = await (await GET(get(`limit=2&cursor=${first.nextCursor}`))).json();
		expect(second.assets).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
	});

	// Assets are install-wide, so there is no per-key `where` a cursor could fall outside of the way
	// a jobs cursor can — but a cursor naming no row at all is exactly as wrong here as it is there,
	// and `assertCursorInFilter` is what turns that into a clear refusal instead of a page that comes
	// up short in a way indistinguishable from "no more records". Mirrors
	// `test/app/api/v1/jobs/route.test.ts`'s "refuses a cursor naming no job at all".
	it("refuses a cursor naming no asset at all", async () => {
		const response = await GET(get("cursor=does-not-exist"));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_query");
	});

	// Distinct from the case above: this cursor names a row that exists, so it only exercises the
	// `kind: "IMAGE"` half of `assertCursorInFilter`'s `where` — a plain non-existent id can't tell
	// that filter apart from the "no such row" case, since both end up refused the same way.
	it("refuses a cursor naming a row that exists but is not IMAGE", async () => {
		const other = await prisma.asset.create({
			data: {
				kind: "STICKER",
				name: "future-kind",
				data: Buffer.alloc(1),
				mimeType: "image/png",
				width: null,
				height: null,
			},
		});

		const response = await GET(get(`cursor=${other.id}`));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_query");
	});

	it("refuses a key without assets:read", async () => {
		await prisma.apiKeyPermission.deleteMany({ where: { apiKeyId: keyId, permission: "assets:read" } });

		expect((await GET(get())).status).toBe(403);
	});
});
