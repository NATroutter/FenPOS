import { beforeEach, describe, expect, it } from "vitest";
import { assertCursorInFilter, pageOf, readPageParams } from "@/lib/api/pagination";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Query parsing and cursor derivation for listing endpoints.
 *
 * The clamping behaviour is the part worth pinning. A caller asking for 10,000 records gets the
 * configured ceiling rather than a 400: a client written against a more permissive install keeps
 * working here, one page at a time, which is what a caller wants from a limit they did not choose.
 * A caller asking for something that is not a number at all is a different case — that is a bug in
 * the client, and it gets told.
 */

beforeEach(async () => {
	await prisma.setting.deleteMany();
});

/**
 * @param query the query string, without the leading `?`
 * @returns a URL carrying it
 */
function urlWith(query: string): URL {
	return new URL(`https://fenpos.test/api/v1/jobs?${query}`);
}

describe("readPageParams", () => {
	it("falls back to the configured default when no limit is asked for", async () => {
		await setSetting("api.defaultPageSize", 25);

		expect((await readPageParams(urlWith(""))).take).toBe(25);
	});

	it("honours a limit within the ceiling", async () => {
		await setSetting("api.maxPageSize", 100);

		expect((await readPageParams(urlWith("limit=10"))).take).toBe(10);
	});

	it("clamps a limit above the ceiling instead of refusing it", async () => {
		await setSetting("api.maxPageSize", 100);

		expect((await readPageParams(urlWith("limit=10000"))).take).toBe(100);
	});

	it("refuses a limit that is not a positive whole number", async () => {
		await expect(readPageParams(urlWith("limit=abc"))).rejects.toMatchObject({ code: "invalid_query" });
		await expect(readPageParams(urlWith("limit=0"))).rejects.toMatchObject({ code: "invalid_query" });
		await expect(readPageParams(urlWith("limit=-5"))).rejects.toMatchObject({ code: "invalid_query" });
		await expect(readPageParams(urlWith("limit=1.5"))).rejects.toMatchObject({ code: "invalid_query" });
	});

	it("passes a cursor through, and reports its absence as null", async () => {
		expect((await readPageParams(urlWith("cursor=job-7"))).cursor).toBe("job-7");
		expect((await readPageParams(urlWith(""))).cursor).toBeNull();
	});
});

describe("assertCursorInFilter", () => {
	it("resolves without throwing when the cursor names a row the caller's own filter would find", async () => {
		await expect(assertCursorInFilter("job-7", async () => ({ id: "job-7" }))).resolves.toBeUndefined();
	});

	it("refuses invalid_query when the resolver finds nothing", async () => {
		await expect(assertCursorInFilter("job-7", async () => null)).rejects.toMatchObject({
			code: "invalid_query",
		});
	});

	it("does not run a query of its own — the resolver is entirely the caller's", async () => {
		let calls = 0;
		await assertCursorInFilter("job-7", async () => {
			calls += 1;
			return { id: "job-7" };
		});

		expect(calls).toBe(1);
	});
});

describe("pageOf", () => {
	it("returns the page and the cursor to continue from when more follow", () => {
		const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

		expect(pageOf(rows, 2)).toEqual({ page: [{ id: "a" }, { id: "b" }], nextCursor: "b" });
	});

	it("reports no cursor when the page is the end of the list", () => {
		const rows = [{ id: "a" }, { id: "b" }];

		expect(pageOf(rows, 2)).toEqual({ page: [{ id: "a" }, { id: "b" }], nextCursor: null });
	});

	it("reports no cursor for an empty result", () => {
		expect(pageOf([], 10)).toEqual({ page: [], nextCursor: null });
	});
});
