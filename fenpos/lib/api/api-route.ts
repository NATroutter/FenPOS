import "server-only";
import { type ApiRouteEntry, apiRouteEntry } from "@/lib/api/api-routes";
import { type ApiLogTarget, recordApiRequest } from "@/lib/api/request-log";
import { toErrorResponse } from "@/lib/errors";
import { type AuthenticatedKey, authenticateKey, requirePermission } from "@/lib/keys/authenticate";

/**
 * The one place a keyed v1 request is authenticated, permitted, recorded and answered.
 *
 * `lib/auth/panel-action.ts` is the same idea for the panel, and the reasons are the same: with one
 * envelope, a refusal is recorded before it returns, so permission probing is visible; a handler
 * that threw is recorded rather than vanishing; and the `try`/`catch` that turns a thrown `ApiError`
 * into the contract's response shape is written once instead of thirteen times.
 *
 * **The permission is hoisted; the device grant is not.** Every route declares exactly one
 * permission and checks it identically, immediately after authentication, so the wrapper owns it and
 * reads it from the registry rather than from an argument — which is what makes `API_ROUTES` the
 * source of truth for what a route requires instead of a list that describes one. The device grant
 * is the opposite on every count: it needs path parameters, it returns a device the handler goes on
 * to use, and it applies to five routes of thirteen. So `requireGrantedDevice` stays in the handler
 * and still throws, and the wrapper catches and records the refusal without ever learning what a
 * device is.
 *
 * **What the wrapper does not own.** `requireApiRead` stays in the handlers that call it: `GET
 * /v1/jobs/{id}` deliberately does not rate-limit while the other reads do, and a limiter driven
 * from `entry.kind` would throttle a route that never was — see `ApiRouteKind`'s own note.
 */

/** What a handler is given. */
export interface ApiRequest<P> {
	/** The authenticated caller, already checked against the route's declared permission. */
	key: AuthenticatedKey;
	request: Request;
	/** The resolved path parameters, `{}` for a route that has none. */
	params: P;
}

/**
 * What a handler returns.
 *
 * The message is part of the return value rather than something a handler may remember to log,
 * because a route that produced no line would be indistinguishable from one nobody ever called. A
 * handler that forgets it is a type error, which is the only enforcement that costs nothing.
 */
export interface ApiRouteResult {
	/** The response to send, built by the handler exactly as it would have been without the wrapper. */
	response: Response;
	/**
	 * One sentence for a person — "Printed 24 lines to bar-printer". The route's identity is already
	 * in the request; what the log line adds is what actually happened.
	 *
	 * The key's name is appended by the wrapper, so a handler need not name it.
	 */
	message: string;
	/**
	 * The agent and device this touched, when it touched one. Denormalised onto the row, which is
	 * what the Logs tab's agent filter and its live stream read — see `recordServerLog`.
	 */
	target?: ApiLogTarget;
}

/** A keyed v1 handler: everything a route does once the caller is known to be allowed to do it. */
export type ApiRouteHandler<P> = (input: ApiRequest<P>) => Promise<ApiRouteResult>;

/**
 * Wraps a handler as a Next route handler.
 *
 * The id is resolved **when this is called**, which for `export const GET = apiRoute(...)` is while
 * the route module is being evaluated, and an id the registry does not declare throws there. That is
 * the whole reason `apiRouteEntry` returns undefined rather than throwing on its own: a typo becomes
 * a route that will not load at all, rather than one that serves traffic and quietly logs nothing —
 * which is the failure nobody would notice, since its symptom is an absence.
 *
 * Control flow, in order: resolve the path parameters, authenticate the key, check the registry's
 * permission, run the handler, record the line, return the handler's response. Anything thrown from
 * any of those steps except the parameter resolution is recorded and converted by `toErrorResponse`,
 * which is passed through unchanged — the wrapper decides nothing about what a caller is told.
 *
 * **A route with path parameters must name their type.** `P` defaults to `Record<string, never>` —
 * the shape of a route that has none — rather than to `Record<string, string>`, which would have
 * accepted every route silently. That default matters because `tsconfig.json` does not set
 * `noUncheckedIndexedAccess`: under the looser default, a dynamic route converted without its type
 * argument still compiles, `params.devcie` types as `string` rather than as an error, and the typo
 * surfaces as `undefined` at runtime. With this default, `Promise<{ agent: string; device: string }>`
 * is not assignable to `Promise<Record<string, never>>`, so leaving the argument off fails typegen
 * instead — write `apiRoute<{ agent: string; device: string }>(...)`.
 *
 * @param id the route's registry id, e.g. `api:GET /v1/jobs`
 * @param handler what the route does once the caller is allowed to do it
 * @returns the function to export as `GET`/`POST`/`DELETE`
 * @throws Error when no route is registered under that id
 */
export function apiRoute<P extends Record<string, string> = Record<string, never>>(
	id: string,
	handler: ApiRouteHandler<P>,
): (request: Request, context?: { params: Promise<P> }) => Promise<Response> {
	const entry = declaredRoute(id);

	return async (request, context) => {
		// Outside the try, exactly where every route resolved its own parameters before this existed:
		// they name the error context below, so there is nothing useful to report until they are known.
		//
		// The `{}` fallback is for a route with no dynamic segments, whose parameters are `{}` anyway.
		// Next supplies a context to every route handler; nothing here depends on it doing so.
		//
		// **This await is the one v1 path that leaves no line, and the only exception to "every API v1
		// request is logged".** A rejection here is outside the `try`, so it is neither recorded by
		// `recordApiRequest` nor converted by `toErrorResponse` — the caller gets Next's own unconverted
		// 500 and the Logs tab gets nothing. Kept here anyway, and deliberately: moving the await inside
		// would buy that one line at the cost of every *other* line's error context, since `params` is
		// what names what was being attempted. No rejection of this promise has been observed in
		// practice, so the exception is narrow — but it is real, and a reader checking the headline
		// claim should find it written down here rather than have to work it out from the brace.
		const params = ((await context?.params) ?? {}) as P;

		// Null until authentication succeeds. A `401` has no key to attribute its line to, and
		// `recordApiRequest` is told that rather than left to guess from an empty string.
		let key: AuthenticatedKey | null = null;

		try {
			key = await authenticateKey(request);
			requirePermission(key, entry.permission);

			const result = await handler({ key, request, params });

			// After the handler, so the read gate is consulted with the outcome already in hand.
			await recordApiRequest(entry, key, {
				status: "returned",
				message: result.message,
				target: result.target,
			});

			return result.response;
		} catch (error) {
			await recordApiRequest(entry, key, { status: "threw", error });
			return toErrorResponse(error, { route: id, ...params });
		}
	};
}

/**
 * The registry entry for an id, or a thrown error.
 *
 * @param id the route's registry id
 * @returns its entry
 * @throws Error when no route is registered under that id
 */
function declaredRoute(id: string): ApiRouteEntry {
	const entry = apiRouteEntry(id);
	if (!entry) {
		throw new Error(`No API route is registered under "${id}"; add it to API_ROUTES or fix the id.`);
	}
	return entry;
}
