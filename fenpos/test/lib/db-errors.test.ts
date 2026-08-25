import { describe, expect, it } from "vitest";
import { isUniqueViolationOn } from "@/lib/db-errors";

/**
 * The one place that knows where this driver reports a unique constraint's columns.
 *
 * `@prisma/adapter-better-sqlite3` puts them at `meta.driverAdapterError.cause.constraint.fields`
 * rather than at the flatter `meta.target` some other Prisma connectors use. That was confirmed
 * against this project's real client rather than assumed, and it is exactly the kind of fact that
 * moves under a driver upgrade — which is why it is asserted here rather than in three modules.
 */
describe("isUniqueViolationOn", () => {
	/** An error shaped the way the installed driver adapter actually reports P2002. */
	function violation(fields: string[]): unknown {
		return {
			code: "P2002",
			meta: { driverAdapterError: { cause: { constraint: { fields } } } },
		};
	}

	it("matches the named constraint", () => {
		expect(isUniqueViolationOn(violation(["prev_hash"]), ["prev_hash"])).toBe(true);
	});

	it("matches a composite constraint whatever order the driver lists it in", () => {
		expect(isUniqueViolationOn(violation(["job_id", "webhook_id"]), ["webhook_id", "job_id"])).toBe(true);
	});

	it("refuses a different constraint on the same table", () => {
		// The reason this is narrow: a broad "some insert failed" check would mistake an unrelated
		// constraint for the race the caller is handling, and answer it as though it were one.
		expect(isUniqueViolationOn(violation(["hash"]), ["prev_hash"])).toBe(false);
	});

	it("refuses a constraint that merely contains the named columns", () => {
		expect(isUniqueViolationOn(violation(["prev_hash", "hash"]), ["prev_hash"])).toBe(false);
	});

	it("refuses an error that is not a unique violation", () => {
		expect(isUniqueViolationOn({ code: "P2025" }, ["prev_hash"])).toBe(false);
		expect(isUniqueViolationOn(new Error("boom"), ["prev_hash"])).toBe(false);
		expect(isUniqueViolationOn(null, ["prev_hash"])).toBe(false);
	});

	it("refuses a unique violation whose shape carries no column names", () => {
		expect(isUniqueViolationOn({ code: "P2002", meta: {} }, ["prev_hash"])).toBe(false);
	});
});
