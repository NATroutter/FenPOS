import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ROUTES, apiRouteEntry } from "@/lib/api/api-routes";

/**
 * Nothing serves v1 traffic outside the envelope.
 *
 * This is the test the central registry was chosen for, and it is the same argument
 * `test/lib/auth/registry-coverage.test.ts` makes about `PANEL_ACTIONS`: a per-file helper could
 * wrap every handler just as well, right up until somebody adds the fourteenth and does not, and
 * there would be nothing to compare the filesystem against. So this walks `app/api/v1/`, finds every
 * exported HTTP method of every route module, and fails when one is not built on `apiRoute` — which
 * makes a handler that logs nothing a build failure rather than something review has to catch. The
 * symptom of that mistake is an absence, and an absence is what nobody notices.
 *
 * It fails in the other direction too, on a registry entry naming a route that no longer exists,
 * because a stale entry is a declared permission nothing goes through and a reader has no way to
 * tell.
 *
 * Source text rather than imports throughout. Importing the modules would prove only that they load,
 * and a module that loads is exactly what a handler exported as a plain function still is.
 */
const V1_ROOT = fileURLToPath(new URL("../../../app/api/v1/", import.meta.url));

/**
 * The one v1 route that is deliberately not a keyed route.
 *
 * No key, no permission, a public schema document — see `API_ROUTES`' own note on why it is absent
 * from the registry. Pinned below so a later tidy-up does not "fix" it into the wrapper.
 */
const UNWRAPPED_BY_DESIGN = "openapi.json/route.ts";

/** Every `route.ts` under `app/api/v1/`, as paths relative to it with forward slashes. */
function routeFiles(directory: string = V1_ROOT): string[] {
	const found: string[] = [];
	for (const name of readdirSync(directory)) {
		const full = join(directory, name);
		if (statSync(full).isDirectory()) {
			found.push(...routeFiles(full));
			continue;
		}
		if (name === "route.ts") {
			found.push(relative(V1_ROOT, full).split(sep).join("/"));
		}
	}
	return found;
}

/**
 * Removes comments, so an `apiRoute(` written *about* the wrapper is not read as a call to it.
 *
 * The same trap `registry-coverage.test.ts` avoids for `"use server"`, and this file has a live
 * instance of it below: the openapi route is asserted to contain no `apiRoute(`, and a comment
 * explaining why it stays outside the wrapper is exactly what a reader would write there.
 */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Where an exported handler starts, whichever form it takes. */
const HANDLER_EXPORT = /export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;

/**
 * The wrapper call, read from the export it belongs to.
 *
 * The optional type argument is what a dynamic route names its parameters with, and it pushes the id
 * onto the next line often enough that this has to span them — `apiRoute<{ agent: string; device:
 * string }>(\n\t"api:POST /v1/print/{agent}/{device}"`.
 */
const WRAPPED = /^export\s+const\s+\w+\s*=\s*apiRoute\s*(?:<[\s\S]*?>)?\s*\(\s*"([^"]+)"/;

/**
 * How far past an export's first character the wrapper call and its id must appear.
 *
 * The longest conversion in the tree runs to about half this. A future one that did not fit would
 * read as unwrapped and fail the check below, which is the safe direction to be wrong in: a false
 * alarm somebody has to look at, never a handler this scan waves through.
 */
const CALL_WINDOW = 240;

/** One exported HTTP method of one route module. */
interface Handler {
	/** The module, relative to `app/api/v1/` — e.g. `devices/[agent]/[device]/raw/route.ts`. */
	file: string;
	method: string;
	/** The registry id this export names, or null when it is not built on `apiRoute` at all. */
	declaredId: string | null;
	/** The id it must name, derived from the path Next mounts it at and the method it exports. */
	expectedId: string;
}

/**
 * The registry id a module's export has to carry, derived from where Next mounts it.
 *
 * Derived rather than read from the file, because reading it from the file is what the checks below
 * are testing. `[agent]` becomes `{agent}`, which is the template form `API_ROUTES` requires.
 *
 * @param file the module, relative to `app/api/v1/`
 * @param method the HTTP method it exports
 * @returns the id, e.g. `api:POST /v1/devices/{agent}/{device}/raw`
 */
function expectedIdFor(file: string, method: string): string {
	const path = file.slice(0, -"/route.ts".length).replace(/\[(\w+)\]/g, "{$1}");
	return `api:${method} /v1/${path}`;
}

/** Every exported handler of every keyed v1 route module. */
function handlers(): Handler[] {
	const found: Handler[] = [];

	for (const file of routeFiles()) {
		if (file === UNWRAPPED_BY_DESIGN) {
			continue;
		}
		const source = withoutComments(readFileSync(join(V1_ROOT, file), "utf8"));
		for (const match of source.matchAll(HANDLER_EXPORT)) {
			const at = match.index ?? 0;
			const built = WRAPPED.exec(source.slice(at, at + CALL_WINDOW));
			found.push({
				file,
				method: match[1],
				declaredId: built?.[1] ?? null,
				expectedId: expectedIdFor(file, match[1]),
			});
		}
	}

	return found;
}

describe("v1 route coverage", () => {
	it("finds the route files and handlers it expects to find", () => {
		// The guard `registry-coverage.test.ts`'s own walker has: a scan that silently matched nothing
		// would pass every assertion below while proving nothing at all. Both scans need one — the file
		// walk, and the handler scan built on top of it — because either could stop matching on its own.
		const files = routeFiles();

		expect(files.length).toBeGreaterThanOrEqual(12);
		expect(files).toContain(UNWRAPPED_BY_DESIGN);
		expect(files).toContain("print/[agent]/[device]/route.ts");
		expect(handlers().length).toBeGreaterThanOrEqual(13);
	});

	it("builds every exported v1 handler with apiRoute", () => {
		// A handler exported as a plain function has no wrapper, so nothing authenticates it from the
		// registry and nothing logs it — which is exactly the gap this plan exists to close.
		const unwrapped = handlers()
			.filter((handler) => handler.declaredId === null)
			.map((handler) => `${handler.file}#${handler.method}`);

		expect(unwrapped).toEqual([]);
	});

	it("names each handler by the path and method it is mounted at", () => {
		// A copy-pasted id is the one conversion mistake `apiRoute` cannot refuse: the registry declares
		// it, so the module loads, and the route then enforces some *other* route's permission and files
		// its lines under some other route's name. `devices/{agent}/{device}/raw` carrying the status
		// route's id would check `status:read` instead of `devices:raw`.
		const misnamed = handlers()
			.filter((handler) => handler.declaredId !== null && handler.declaredId !== handler.expectedId)
			.map((handler) => `${handler.file}#${handler.method} names ${handler.declaredId}, not ${handler.expectedId}`);

		expect(misnamed).toEqual([]);
	});

	it("has a registry entry for every exported v1 handler", () => {
		// Add it to `lib/api/api-routes.ts` with the permission its handler checks today. An unregistered
		// id throws inside `apiRoute` at module load, so this names the omission rather than leaving a
		// reader to work it out from a route that will not import.
		const missing = handlers()
			.filter((handler) => !apiRouteEntry(handler.expectedId))
			.map((handler) => handler.expectedId);

		expect(missing).toEqual([]);
	});

	it("has no registry entry for a handler that no longer exists", () => {
		// The other direction: a stale entry is a declared permission nothing goes through.
		const live = new Set(handlers().map((handler) => handler.expectedId));
		const stale = API_ROUTES.filter((entry) => !live.has(entry.id)).map((entry) => entry.id);

		expect(stale).toEqual([]);
	});

	it("leaves openapi.json outside the wrapper", () => {
		// Deliberate, and worth pinning so a later tidy-up does not "fix" it: no key, no permission, a
		// public schema document. Wrapping it would put the whole API's description behind a credential
		// a client generator does not have.
		const source = withoutComments(readFileSync(join(V1_ROOT, UNWRAPPED_BY_DESIGN), "utf8"));

		expect(source).not.toContain("apiRoute(");
	});
});
