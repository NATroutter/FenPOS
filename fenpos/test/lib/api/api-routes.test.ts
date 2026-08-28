import { describe, expect, it } from "vitest";
import { API_ROUTES, apiRouteEntry } from "@/lib/api/api-routes";
import { PERMISSION_IDS } from "@/lib/domain/permissions";

describe("the API route registry", () => {
	it("covers the thirteen keyed v1 handlers", () => {
		// A vacuity guard on the registry itself: an empty one would satisfy every assertion below.
		expect(API_ROUTES).toHaveLength(13);
	});

	it("names every route with a templated path, never an interpolated one", () => {
		for (const entry of API_ROUTES) {
			expect(entry.id).toMatch(/^api:(GET|POST|DELETE) \/v1\/[\w/{}.-]*$/);
			// Goes red on `api:POST /v1/print/site-a/kitchen`: an id built from a real name would
			// make every device its own action in the logs and break every filter on it.
			expect(entry.id).not.toMatch(/\/(site-a|kitchen)\b/);
		}
	});

	it("declares a permission that exists", () => {
		for (const entry of API_ROUTES) {
			expect(PERMISSION_IDS).toContain(entry.permission);
		}
	});

	it("has no duplicate ids", () => {
		expect(new Set(API_ROUTES.map((entry) => entry.id)).size).toBe(API_ROUTES.length);
	});

	it("declares preview as a query even though it is a POST", () => {
		// The case that proves `kind` is declared rather than derived from the method.
		expect(apiRouteEntry("api:POST /v1/preview/{agent}/{device}")?.kind).toBe("query");
	});

	it("declares print as a command", () => {
		expect(apiRouteEntry("api:POST /v1/print/{agent}/{device}")?.kind).toBe("command");
	});
});
