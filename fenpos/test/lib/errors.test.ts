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

describe("raw_writes_disabled", () => {
	it("is a 403, like any other refusal of an identified caller", () => {
		expect(API_ERROR_STATUS.raw_writes_disabled).toBe(403);
	});

	it("is distinct from insufficient_permission, which it would otherwise be mistaken for", () => {
		// Two different remedies. `insufficient_permission` means "ask for the grant";
		// `raw_writes_disabled` means "ask the operator to switch it on for the install". A caller
		// told the wrong one goes to the wrong person.
		expect(API_ERROR_STATUS.raw_writes_disabled).toBe(API_ERROR_STATUS.insufficient_permission);

		// Same status, so only the code tells the two apart — which means the code has to exist in its
		// own right. Read off the map rather than compared as two literals: `"a" !== "b"` typed into a
		// test asserts nothing about the code, and would still pass if the map lost the key entirely.
		expect(Object.keys(API_ERROR_STATUS)).toContain("raw_writes_disabled");
	});
});
