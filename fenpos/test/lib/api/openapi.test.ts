import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "@/lib/api/openapi";
import { PERMISSION_IDS } from "@/lib/domain/permissions";

/**
 * The machine-readable description of this API, checked against the API.
 *
 * Hand-written documents rot. This is the same technique `docs-check.test.ts` uses on the prose
 * pages, pointed at the spec instead: the route tree is walked and every endpoint must appear, so an
 * endpoint added without a path entry fails the suite rather than shipping a spec that quietly omits
 * it. What the entry *says* is still a human's responsibility; that it exists is not.
 */

const DOCUMENT = openApiDocument("https://fenpos.example.com") as {
	openapi: string;
	servers: { url: string }[];
	paths: Record<string, Record<string, unknown>>;
	components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
};

/**
 * Every versioned route, as the path an integrator calls.
 *
 * @returns paths like `/api/v1/devices/{agent}/{device}`
 */
function routePaths(): string[] {
	return readdirSync("app/api/v1", { recursive: true, encoding: "utf8" })
		.filter((entry) => /route\.ts$/.test(entry))
		.map((entry) => `/api/v1/${entry.replaceAll("\\", "/").replace(/\/route\.ts$/, "")}`)
		.map((path) => path.replace(/\[(\.\.\.)?([^\]]+)\]/g, "{$2}"));
}

describe("openApiDocument", () => {
	it("declares a version this tooling understands", () => {
		expect(DOCUMENT.openapi).toMatch(/^3\./);
	});

	it("names the install's own address as the server", () => {
		expect(DOCUMENT.servers[0].url).toBe("https://fenpos.example.com");
	});

	it("describes every versioned endpoint", () => {
		for (const path of routePaths()) {
			expect(Object.keys(DOCUMENT.paths), `${path} has no entry in the OpenAPI document`).toContain(path);
		}
	});

	it("describes no endpoint that does not exist", () => {
		const actual = routePaths();
		for (const documented of Object.keys(DOCUMENT.paths)) {
			expect(actual, `${documented} is documented but has no route`).toContain(documented);
		}
	});

	it("declares bearer authentication", () => {
		expect(DOCUMENT.components.securitySchemes).toHaveProperty("bearerAuth");
	});

	it("describes the error envelope every non-2xx shares", () => {
		expect(DOCUMENT.components.schemas).toHaveProperty("Error");
	});

	it("mentions every permission somewhere, so a reader can see what a key needs", () => {
		const text = JSON.stringify(DOCUMENT);
		for (const permission of PERMISSION_IDS) {
			expect(text, `${permission} is not mentioned in the OpenAPI document`).toContain(permission);
		}
	});
});
