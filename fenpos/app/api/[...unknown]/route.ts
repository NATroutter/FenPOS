import { API_BASE, API_VERSION } from "@/lib/api-version";
import { ApiError } from "@/lib/errors";

/**
 * Anything under `/api` that no other route claims.
 *
 * Next answers an unmatched path with its own HTML error page, which on this API would be the one
 * response that is not the `{ error, message }` envelope every client is told to branch on — and it
 * arrives at the moment a caller is least able to guess why. A client pinned to a path that has
 * moved between versions is the likeliest way to get here, so the refusal names the version this
 * build actually serves rather than only saying no.
 *
 * More specific routes win, so this shadows nothing: `/api/health`, `/api/events`, `/api/pair` and
 * everything under `/api/{API_VERSION}` are matched by their own files first. What is left is a
 * wrong version, a retired path, or a typo — and a half-built path like `/api/v1/print/kitchen`
 * with no device, which would otherwise 404 as HTML too.
 */

/** Never cached: what is missing may not be missing after a deploy. */
export const dynamic = "force-dynamic";

/**
 * Refuses one request, in the contract's own shape.
 *
 * @param request the incoming request, read only for its path
 * @returns the JSON refusal
 */
function refuse(request: Request): Response {
	const { pathname } = new URL(request.url);

	return new ApiError(
		"unknown_endpoint",
		`No endpoint at ${pathname}. This server serves ${API_VERSION} of the print API, at ${API_BASE}/.`,
		{ path: pathname, version: API_VERSION },
	).toResponse();
}

// Every method, not just GET: a POST to a stale path is the case this exists for, and a method
// without a handler would fall back to Next's 405 HTML and reintroduce the hole one verb down.
export const GET = refuse;
export const POST = refuse;
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;
export const HEAD = refuse;
export const OPTIONS = refuse;
