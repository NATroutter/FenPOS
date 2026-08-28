import type { Permission } from "@/lib/domain/permissions";

/**
 * Every keyed v1 API route, and what it takes to call one.
 *
 * A central registry rather than a check inside each route, for the reason
 * `lib/auth/panel-actions.ts` states about itself: a per-file helper could not do that — there
 * would be nothing to compare the filesystem against. Task 11's coverage test is the thing that
 * needs something to compare against, walking `app/api/v1/` the same way `panel-actions.ts`'s own
 * coverage test walks `app/`.
 *
 * **Ids use template form, never an interpolated one.** `api:POST /v1/print/{agent}/{device}`, not
 * `api:POST /v1/print/site-a/kitchen` — an id built from a real device name would make every device
 * its own action in the logs and break every filter that names the route rather than the device.
 *
 * `GET /v1/openapi.json` is deliberately absent: it takes no key and checks no permission, a public
 * schema document rather than a keyed route.
 */

/**
 * How a route is gated, and what it means for the log line it produces.
 *
 * **Declared, not inferred from the HTTP method.** `POST /v1/preview/{agent}/{device}` is a
 * `query`: it renders a receipt and changes nothing, but must be a `POST` because the caller sends
 * content in the body. Deriving `kind` from the method would call that a `command`, which is wrong
 * on the one axis this type actually speaks to — whether the route changes something on the far
 * side of the request.
 *
 * **`kind` must not drive rate limiting.** `GET /v1/jobs/{id}` does not call `requireApiRead` while
 * every other read does, so a limiter derived from `kind` would throttle a route that never was.
 * Whatever wraps a handler with a limiter has to read that handler's own choice, not infer one from
 * this field.
 */
export type ApiRouteKind = "command" | "query";

/** One v1 route, and what calling it requires. */
export interface ApiRouteEntry {
	/**
	 * `api:<METHOD> <path>`, with path parameters in template form (`{agent}`). Unique across the
	 * registry.
	 */
	readonly id: string;
	readonly kind: ApiRouteKind;
	/** The permission the handler checks with `requirePermission` before doing anything else. */
	readonly permission: Permission;
}

/**
 * The registry.
 *
 * Ordered by resource, so a reader checking that a resource is fully covered reads one contiguous
 * block rather than hunting. Each entry's permission is the one its handler calls
 * `requirePermission` with today, read from the route file rather than chosen for this list — a
 * stricter or looser value here would be a behaviour change hiding inside what looks like a
 * refactor, once Task 11 deletes the calls this was copied from.
 */
export const API_ROUTES: readonly ApiRouteEntry[] = [
	// --- Status ---
	{ id: "api:GET /v1/status", kind: "query", permission: "status:read" },

	// --- Devices ---
	{ id: "api:GET /v1/devices", kind: "query", permission: "devices:read" },
	{ id: "api:GET /v1/devices/{agent}/{device}", kind: "query", permission: "devices:read" },
	{ id: "api:POST /v1/devices/{agent}/{device}/actions", kind: "command", permission: "devices:control" },
	{ id: "api:POST /v1/devices/{agent}/{device}/raw", kind: "command", permission: "devices:raw" },

	// --- Jobs ---
	{ id: "api:GET /v1/jobs", kind: "query", permission: "jobs:read" },
	{ id: "api:GET /v1/jobs/{id}", kind: "query", permission: "jobs:read" },
	{ id: "api:DELETE /v1/jobs/{id}", kind: "command", permission: "jobs:cancel" },

	// --- Assets ---
	{ id: "api:GET /v1/assets", kind: "query", permission: "assets:read" },
	{ id: "api:POST /v1/assets", kind: "command", permission: "assets:write" },
	{ id: "api:DELETE /v1/assets/{name}", kind: "command", permission: "assets:write" },

	// --- Tools ---
	{ id: "api:POST /v1/preview/{agent}/{device}", kind: "query", permission: "print" },
	{ id: "api:POST /v1/print/{agent}/{device}", kind: "command", permission: "print" },
] as const satisfies readonly ApiRouteEntry[];

/**
 * Finds a route by its id.
 *
 * Returns undefined rather than throwing, unlike `panelActionEntry`: a caller here is typically
 * Task 11's coverage test, or logging middleware asking "is this a registered route at all" rather
 * than a gate that must stop a request the instant the answer is no.
 *
 * @param id the route's registry id
 * @returns its entry, or undefined when no route is registered under that id
 */
export function apiRouteEntry(id: string): ApiRouteEntry | undefined {
	return API_ROUTES.find((entry) => entry.id === id);
}
