import { describe, expect, it } from "vitest";
import { API_ERROR_STATUS, ApiError } from "@/lib/errors";

/**
 * The status each error code maps to.
 *
 * Codes are a stored contract — clients branch on them — so this file exists to make a change to
 * one deliberate rather than incidental. It asserts the buckets, not every code: what matters is
 * that a code means the same thing to a client tomorrow as it did today.
 */

describe("new lifecycle error codes", () => {
	it("reports a mismatched idempotency key as a conflict", () => {
		expect(API_ERROR_STATUS.idempotency_conflict).toBe(409);
	});

	it("reports a bad query parameter as a bad request", () => {
		// Not 422. The envelope is wrong, not the receipt — there is no line or column to name.
		expect(API_ERROR_STATUS.invalid_query).toBe(400);
	});

	it("reports an unreachable webhook target as unavailable", () => {
		expect(API_ERROR_STATUS.webhook_unreachable).toBe(503);
	});

	it("derives the status from the code, so a handler never chooses one", () => {
		expect(new ApiError("idempotency_conflict", "…").status).toBe(409);
	});
});
