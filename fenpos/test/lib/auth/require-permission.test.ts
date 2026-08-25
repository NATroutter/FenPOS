import { describe, expect, it } from "vitest";
import { PermissionDeniedError, REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import { ApiError } from "@/lib/errors";

/**
 * How a refusal is shaped.
 *
 * `requirePagePermission` itself is exercised through the pages that call it rather than directly:
 * it reaches `next/navigation`'s `redirect`, which signals by throwing, and a test that mocked that
 * away would be asserting against the mock. What is worth pinning here is the error type the action
 * gate raises and the one sentence every refusal shows.
 */
describe("permission refusal", () => {
	it("is an ApiError, so an action's existing catch reports it as a message", () => {
		const denied = new PermissionDeniedError("devices:delete");

		// The whole reason it extends ApiError: every `run()` helper in this codebase already passes
		// an ApiError's message through and logs anything else as unexpected. A refusal is entirely
		// expected, and logging it as a fault would bury the ones that are not.
		expect(denied).toBeInstanceOf(ApiError);
		expect(denied.message).toBe(REFUSAL_MESSAGE);
	});

	it("carries the code the API already uses for exactly this", () => {
		// `insufficient_permission` predates the panel's permissions and means the same thing there:
		// the caller is identified and lacks the permission for this action.
		expect(new PermissionDeniedError("devices:delete").code).toBe("insufficient_permission");
	});

	it("carries the permission it refused without showing it", () => {
		const denied = new PermissionDeniedError("settings:write:security");

		expect(denied.permission).toBe("settings:write:security");
		expect(denied.message).not.toContain("settings:write:security");
	});

	it("says who to ask", () => {
		expect(REFUSAL_MESSAGE.toLowerCase()).toContain("administrator");
	});
});
