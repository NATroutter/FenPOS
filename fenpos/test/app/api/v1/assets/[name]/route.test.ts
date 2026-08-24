import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DELETE } from "@/app/api/v1/assets/[name]/route";
import { createAsset, RESERVED_ASSET_NAME } from "@/lib/assets/asset-service";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

/**
 * `DELETE /api/v1/assets/{name}` — removing a stored image.
 *
 * Addressed by name because that is what markup references and what the caller chose. An id would be
 * a cuid they never saw, and a second way to name the same thing.
 */

const PNG = readFileSync("test/fixtures/logo.png");
let token: string;
let keyId: string;

/**
 * @param name the asset name in the path
 * @returns the arguments to spread into `DELETE`
 */
function call(name: string): [Request, { params: Promise<{ name: string }> }] {
	return [
		new Request(`https://fenpos.test/api/v1/assets/${name}`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
		}),
		{ params: Promise.resolve({ name }) },
	];
}

beforeEach(async () => {
	await prisma.asset.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();

	token = `fp_${Date.now()}_${Math.random()}`;
	const key = await prisma.apiKey.create({
		data: {
			name: "deploy",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "assets:write" }] },
		},
	});
	keyId = key.id;

	await createAsset("shop-logo", PNG);
});

describe("DELETE /api/v1/assets/{name}", () => {
	it("removes the asset and answers with no content", async () => {
		const response = await DELETE(...call("shop-logo"));

		expect(response.status).toBe(204);
		expect(await prisma.asset.count()).toBe(0);
	});

	it("reports an asset that is not there as unknown", async () => {
		const response = await DELETE(...call("never-existed"));

		expect(response.status).toBe(404);
		expect((await response.json()).error).toBe("unknown_asset");
	});

	it("refuses to delete the bundled logo, which is not an asset to remove", async () => {
		const response = await DELETE(...call(RESERVED_ASSET_NAME));

		// `invalid_type`, matching what the write path answers for the same name. The logo is not a
		// missing asset and not a taken name — it is not an asset at all, and one code for both
		// directions is what stops a caller concluding it merely has not been uploaded yet.
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_type");
	});

	it("refuses a key without assets:write", async () => {
		await prisma.apiKeyPermission.deleteMany({ where: { apiKeyId: keyId } });

		const response = await DELETE(...call("shop-logo"));

		expect(response.status).toBe(403);
		expect(await prisma.asset.count()).toBe(1);
	});
});
