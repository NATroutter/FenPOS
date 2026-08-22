import { describe, expect, it } from "vitest";
import {
	acceptedImageFormatsClause,
	allowedHostsClause,
	remoteLimitLead,
	remoteLimitTrail,
	schemeClause,
} from "@/app/(panel)/docs/prose";

/**
 * Tests for the markup docs page's remote-image sentence, at the boundary that matters and the two
 * ordinary values either side of it.
 *
 * These two functions exist because the sentence they build cannot be checked by rendering the
 * page — `docs-check.test.ts` reads that page as static text for the same reason, since this
 * project's tests run in a plain Node environment rather than a browser. Zero is the case worth
 * pinning: `images.maxRemoteReferences` set to 0 switches outbound image fetching off entirely
 * (`resolve-images.ts`), and the sentence has to read as a deliberate choice rather than a broken
 * limit of zero.
 */
describe("remoteLimitLead", () => {
	it("says outbound image fetching is switched off at zero, not a limit of zero", () => {
		const lead = remoteLimitLead(0);
		expect(lead).toMatch(/switched off/i);
		expect(lead).not.toMatch(/at most 0/i);
	});

	it("uses the singular at exactly one", () => {
		expect(remoteLimitLead(1)).toBe("One request may name at most 1 distinct URL, or");
	});

	it("uses the plural at the fallback default", () => {
		expect(remoteLimitLead(12)).toBe("One request may name at most 12 distinct URLs, or");
	});
});

describe("remoteLimitTrail", () => {
	it("points at the Assets tab when URL images are switched off", () => {
		expect(remoteLimitTrail(0)).toMatch(/Assets tab/i);
	});

	it("notes stored images are uncounted otherwise", () => {
		expect(remoteLimitTrail(1)).toMatch(/not counted/i);
		expect(remoteLimitTrail(12)).toMatch(/not counted/i);
	});
});

describe("schemeClause", () => {
	it("names both schemes when plain http is allowed", () => {
		expect(schemeClause(true)).toBe("http or https only");
	});

	it("names only https once plain http is switched off", () => {
		expect(schemeClause(false)).toBe("https only");
	});
});

describe("allowedHostsClause", () => {
	it("adds nothing when the allowlist is empty, meaning any host", () => {
		expect(allowedHostsClause("")).toBe("");
	});

	it("adds nothing for a value that is only whitespace", () => {
		expect(allowedHostsClause("   ")).toBe("");
	});

	it("names the configured hosts when the allowlist is not empty", () => {
		expect(allowedHostsClause("cdn.example.com, images.example.com")).toBe(
			", and only from cdn.example.com, images.example.com",
		);
	});
});

describe("acceptedImageFormatsClause", () => {
	it("names both formats when both are accepted", () => {
		expect(acceptedImageFormatsClause("png+jpeg")).toBe("a PNG or a JPEG");
	});

	it("names only PNG when JPEG is turned off", () => {
		expect(acceptedImageFormatsClause("png")).toBe("a PNG");
	});
});
