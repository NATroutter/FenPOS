import { describe, expect, it } from "vitest";
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "@/app/api/[...unknown]/route";
import { API_BASE, API_VERSION } from "@/lib/api-version";
import { API_ERROR_STATUS } from "@/lib/errors";

/**
 * Tests for the refusal that stands where no endpoint does.
 *
 * The property worth the file is narrow and easy to lose: an unmatched path under `/api` must come
 * back as the same `{ error, message }` envelope as every other refusal. Without this route Next
 * answers with its own HTML error page — the one response on the whole API a client's JSON parser
 * cannot read, served at the moment the client is least able to guess what happened. Versioning the
 * public API made that reachable by accident rather than by typo, which is why it is now covered.
 */

/** Every method the route exports, so a hole cannot open one verb down. */
const HANDLERS = { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS };

/**
 * Calls one handler for a path.
 *
 * @param handler the exported method handler
 * @param path the path to ask for
 * @returns the response
 */
function call(handler: (request: Request) => Response, path: string): Response {
	return handler(new Request(`https://fenpos.test${path}`));
}

describe("the /api catch-all", () => {
	it("answers a path that has moved between versions with the error envelope", async () => {
		const response = call(GET, "/api/print/kitchen/till");

		expect(response.status).toBe(API_ERROR_STATUS.unknown_endpoint);
		expect(response.headers.get("content-type")).toContain("application/json");

		const body = await response.json();
		expect(body.error).toBe("unknown_endpoint");
		expect(body.path).toBe("/api/print/kitchen/till");
		expect(body.version).toBe(API_VERSION);
	});

	/**
	 * The message has to name where the endpoints went. A refusal that only says "no" leaves the
	 * caller with the same question they arrived with, and this is the one response that reaches a
	 * client which has guessed the version wrong.
	 */
	it("names the version this build serves, and where it lives", async () => {
		const body = await call(GET, "/api/v9/print/kitchen/till").json();

		expect(body.message).toContain(API_VERSION);
		expect(body.message).toContain(API_BASE);
	});

	it("refuses every method, not only GET", async () => {
		for (const [method, handler] of Object.entries(HANDLERS)) {
			const response = call(handler, "/api/print/kitchen/till");
			expect(response.status, `${method} did not refuse`).toBe(API_ERROR_STATUS.unknown_endpoint);
		}
	});

	/**
	 * A half-built path, which is the shape a hand-written URL fails in: the device segment is
	 * missing, so the real route does not match and this one has to answer instead.
	 */
	it("answers a versioned path that is short a segment", async () => {
		const body = await call(POST, `${API_BASE}/print/kitchen`).json();

		expect(body.error).toBe("unknown_endpoint");
		expect(body.path).toBe(`${API_BASE}/print/kitchen`);
	});

	it("reports the path it was asked for, not a fixed string", async () => {
		const first = await call(GET, "/api/nope").json();
		const second = await call(GET, "/api/also/nope").json();

		expect(first.path).toBe("/api/nope");
		expect(second.path).toBe("/api/also/nope");
	});
});
