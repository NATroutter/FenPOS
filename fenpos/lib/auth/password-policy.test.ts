import { describe, expect, it } from "vitest";
import { minimumLengthPhrase } from "@/lib/auth/password-policy";

/**
 * Boundary tests for the phrase `passwordSchema`'s message and every "At least N characters" hint
 * in the panel share, at the values that matter: `auth.minimumPasswordLength`'s declared `min` and
 * `max` (`settings-service.ts`), and 1 — the count whose grammar the format string could get
 * wrong. Mirrors `app/(panel)/docs/prose.test.ts`'s `remoteLimitLead` tests, which exist for the
 * same reason: the sentence changes shape at a boundary, and this project has broken that kind of
 * sentence three times already ("0 MB", "1 distinct URLs", "1 hours").
 */
describe("minimumLengthPhrase", () => {
	it("uses the singular at exactly one", () => {
		expect(minimumLengthPhrase(1)).toBe("1 character");
	});

	it("uses the plural at the setting's minimum", () => {
		expect(minimumLengthPhrase(12)).toBe("12 characters");
	});

	it("uses the plural at the setting's maximum", () => {
		expect(minimumLengthPhrase(128)).toBe("128 characters");
	});
});
