import { describe, expect, it } from "vitest";
import {
	DEFAULT_PASSWORD_POLICY,
	describePasswordPolicy,
	hasDigit,
	hasMixedCase,
	hasSymbol,
	minimumLengthPhrase,
} from "@/lib/auth/password-policy";

/**
 * Boundary tests for the phrase `passwordSchema`'s message and every "At least N characters" hint
 * in the panel share, at the values that matter: `auth.minimumPasswordLength`'s declared `min` and
 * `max` (`settings-service.ts`), and 1 — the count whose grammar the format string could get
 * wrong. Mirrors `test/app/(panel)/docs/prose.test.ts`'s `remoteLimitLead` tests, which exist for the
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

/**
 * The three complexity predicates.
 *
 * Each is its own function rather than an inline regex in the schema, so the one rule with a real
 * judgement in it — that a space is not a symbol — is stated once and tested directly.
 */
describe("complexity predicates", () => {
	it("wants both cases, not either", () => {
		expect(hasMixedCase("all lower")).toBe(false);
		expect(hasMixedCase("ALL UPPER")).toBe(false);
		expect(hasMixedCase("Both Cases")).toBe(true);
	});

	it("finds a digit anywhere", () => {
		expect(hasDigit("no digits")).toBe(false);
		expect(hasDigit("one 1 digit")).toBe(true);
	});

	it("does not count a space as a symbol", () => {
		// Spaces are what make a passphrase readable. Counting one would make the setting do nothing
		// for exactly the passwords somebody turned it on to constrain.
		expect(hasSymbol("correct horse battery staple")).toBe(false);
		expect(hasSymbol("correct-horse")).toBe(true);
	});
});

describe("describePasswordPolicy", () => {
	it("names only the length when nothing else is required", () => {
		expect(describePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, minimumLength: 12 })).toBe("At least 12 characters.");
	});

	it("names one added requirement without a list", () => {
		expect(describePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, minimumLength: 12, requireDigit: true })).toBe(
			"At least 12 characters, including a digit.",
		);
	});

	it("joins two added requirements with 'and'", () => {
		expect(
			describePasswordPolicy({
				...DEFAULT_PASSWORD_POLICY,
				minimumLength: 12,
				requireDigit: true,
				requireSymbol: true,
			}),
		).toBe("At least 12 characters, including a digit and a symbol.");
	});

	it("joins three with commas and a final 'and'", () => {
		expect(
			describePasswordPolicy({
				minimumLength: 12,
				requireMixedCase: true,
				requireDigit: true,
				requireSymbol: true,
			}),
		).toBe("At least 12 characters, including upper and lower case, a digit and a symbol.");
	});

	it("phrases a minimum of one without pluralising", () => {
		// The boundary this project has broken three times. `minimumLengthPhrase` exists for it, and
		// this is the assertion that it is actually reached from here.
		expect(describePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, minimumLength: 1 })).toBe("At least 1 character.");
	});
});
