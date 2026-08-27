import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Better Auth's own HTTP endpoints are not served.
 *
 * Better Auth mounts a whole router — sign-in, sign-out, session, the two-factor plugin's routes and
 * the admin plugin's — the moment its handler is exported from a route file. None of it is used:
 * this panel has no Better Auth browser client, and every auth operation runs through a server
 * action calling `auth.api.*` in process. So mounting it published a second, ungated way in.
 *
 * That way in bypassed everything `app/(auth)/login/actions.ts` applies before it reaches the
 * credential — the per-address throttle, the address allowlist, the account lockout, and the
 * `auth:sign-in` audit row. Confirmed against a running server: eight consecutive failures through
 * `POST /api/auth/sign-in/email` returned eight 401s with no throttle, left `failedSignInCount` at
 * zero, and wrote no audit row at all, while the same eight through the panel would have been
 * refused at the sixth and recorded eight times.
 *
 * `auth.ts`'s `disableSignUp` already closed exactly this hole for `/api/auth/sign-up/email`, and
 * its comment says why in the same terms. This test generalises that fix: rather than disabling
 * endpoints one at a time as each is noticed, nothing may mount the router at all.
 *
 * Deleting the route is what makes the property true; this is what keeps it true. Re-adding a file
 * that exports the handler turns a silent reopening of the hole into a failing build.
 */
const APP_ROOT = fileURLToPath(new URL("../../../app/", import.meta.url));

/** Every `.ts`/`.tsx` file under `app/`, as paths relative to it with forward slashes. */
function sourceFiles(directory: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(directory)) {
		const full = join(directory, name);
		if (statSync(full).isDirectory()) {
			found.push(...sourceFiles(full));
			continue;
		}
		if (name.endsWith(".ts") || name.endsWith(".tsx")) {
			found.push(relative(APP_ROOT, full).split(sep).join("/"));
		}
	}
	return found;
}

/** Strips comments, so this file's own prose about `toNextJsHandler` is not read as a mount. */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The two ways Better Auth's router reaches the network.
 *
 * `toNextJsHandler(auth)` is the documented one. `auth.handler` is the raw fetch handler the same
 * router exposes, and exporting it from a route file mounts exactly as much surface, so a test that
 * only knew the first name would pass while the hole stood open.
 */
const MOUNTING_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
	{ label: "toNextJsHandler(...)", pattern: /toNextJsHandler\s*\(/ },
	{ label: "auth.handler", pattern: /\bauth\s*\.\s*handler\b/ },
];

describe("Better Auth's HTTP router", () => {
	const files = sourceFiles(APP_ROOT);

	it("has routes to scan, so this suite cannot pass by finding nothing", () => {
		// Without this, a broken APP_ROOT would make every assertion below vacuously true.
		expect(files.filter((path) => path.endsWith("route.ts")).length).toBeGreaterThanOrEqual(10);
	});

	it("is not mounted by any route under app/", () => {
		const mounted = files.flatMap((path) => {
			const source = withoutComments(readFileSync(join(APP_ROOT, path), "utf8"));
			return MOUNTING_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(
				({ label }) => `${path} mounts Better Auth via ${label}`,
			);
		});

		expect(mounted).toEqual([]);
	});

	it("has no route file under app/api/auth at all", () => {
		expect(files.filter((path) => path.startsWith("api/auth/"))).toEqual([]);
	});
});
