import { deleteAsset, RESERVED_ASSET_NAME } from "@/lib/assets/asset-service";
import { prisma } from "@/lib/db";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { authenticateKey, requirePermission } from "@/lib/keys/authenticate";
import { logger } from "@/lib/logger";

/**
 * `DELETE /api/v1/assets/{name}` — removing a stored image.
 *
 * Addressed by name, which is what markup references and what the caller chose. The id is a cuid
 * they never saw, and publishing one would become a second way to name the same thing that
 * integrators would then depend on.
 *
 * Answers 204 rather than a body. There is nothing left to describe: the asset is gone, and a body
 * restating the name the caller just sent is ceremony.
 *
 * A receipt already referring to this image will now fail to print with `unknown_asset` — that is
 * the same consequence deleting from the Assets tab has, and it belongs to whoever deletes.
 */

export async function DELETE(request: Request, context: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await context.params;

	try {
		const key = await authenticateKey(request);
		requirePermission(key, "assets:write");

		// Refused before the lookup, and with the same code the write path answers for this name. The
		// bundled logo is not a missing asset and not an occupied name — it is not an asset at all,
		// and `unknown_asset` here would invite a caller to conclude it just has not been uploaded.
		if (name === RESERVED_ASSET_NAME) {
			throw new ApiError(
				"invalid_type",
				`'${RESERVED_ASSET_NAME}' is the application's own logo rather than a stored asset, so it cannot be deleted.`,
				{ field: "name" },
			);
		}

		const asset = await prisma.asset.findUnique({
			where: { kind_name: { kind: "IMAGE", name } },
			select: { id: true },
		});

		if (!asset) {
			throw new ApiError("unknown_asset", `There is no image called '${name}'.`);
		}

		await deleteAsset(asset.id);

		logger.info("Asset deleted through the API", { keyId: key.id, name });

		return new Response(null, { status: 204 });
	} catch (error) {
		return toErrorResponse(error, { route: "DELETE /api/v1/assets/[name]", name });
	}
}
