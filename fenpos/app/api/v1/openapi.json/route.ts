import { openApiDocument } from "@/lib/api/openapi";
import { toErrorResponse } from "@/lib/errors";
import { getPublicAddress } from "@/lib/public-url";

/**
 * `GET /api/v1/openapi.json` — a machine-readable description of this API.
 *
 * Unauthenticated, deliberately. A spec describes the shape of the API rather than the contents of
 * an install — it names no agent, device, job or asset — and a client generator should not need a
 * credential to read one. `/api/health` is unauthenticated for a related reason and says as little
 * as possible; this says far more, though not nothing about this install: `servers[0].url` is
 * `getPublicAddress`'s own answer, the configured public address or one inferred from the request,
 * so an unauthenticated caller does learn that much.
 *
 * Served from the versioned prefix rather than beside it: a v2 would describe itself, and a client
 * pinned to v1 should keep getting v1's description.
 */

/** Never prerendered: the server URL is read from a setting an operator may change. */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	try {
		const { url } = await getPublicAddress();
		return Response.json(openApiDocument(url));
	} catch (error) {
		return toErrorResponse(error, { route: "GET /api/v1/openapi.json" });
	}
}
