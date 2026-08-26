import { describe, expect, it } from "vitest";
import { addressAllowed, parseAllowlist } from "@/lib/auth/ip-allowlist";

/**
 * Who may reach the panel at all.
 *
 * Pure, so the matching rules are pinned here rather than discovered on an install where getting them
 * wrong in one direction protects nothing and in the other locks everybody out.
 */
describe("parseAllowlist", () => {
	it("splits on commas and newlines alike", () => {
		expect(parseAllowlist("10.0.0.1, 10.0.0.2\n10.0.0.3")).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
	});

	it("drops blank entries and surrounding space", () => {
		expect(parseAllowlist("  10.0.0.1 ,, \n , 10.0.0.2  ")).toEqual(["10.0.0.1", "10.0.0.2"]);
	});

	it("reads an empty setting as an empty list", () => {
		expect(parseAllowlist("")).toEqual([]);
		expect(parseAllowlist("   \n  ")).toEqual([]);
	});
});

describe("addressAllowed", () => {
	it("allows everything when the list is empty", () => {
		// The default, and the one that must never be got wrong: an empty allowlist is "unrestricted",
		// not "nobody".
		expect(addressAllowed("203.0.113.5", "")).toBe(true);
		expect(addressAllowed("203.0.113.5", "  \n ")).toBe(true);
	});

	it("allows an exact match", () => {
		expect(addressAllowed("203.0.113.5", "203.0.113.5")).toBe(true);
	});

	it("refuses an address not on the list", () => {
		expect(addressAllowed("203.0.113.9", "203.0.113.5, 10.0.0.1")).toBe(false);
	});

	it("allows an address inside a CIDR range", () => {
		expect(addressAllowed("10.0.3.7", "10.0.0.0/16")).toBe(true);
	});

	it("refuses an address outside a CIDR range", () => {
		expect(addressAllowed("10.1.3.7", "10.0.0.0/16")).toBe(false);
	});

	it("handles a /32 as an exact match", () => {
		expect(addressAllowed("10.0.0.1", "10.0.0.1/32")).toBe(true);
		expect(addressAllowed("10.0.0.2", "10.0.0.1/32")).toBe(false);
	});

	it("handles /0 as everything", () => {
		// The case a naive 32-bit shift gets wrong: `-1 << 32` is -1 in JavaScript, not 0, so without
		// its own branch a /0 entry would admit only itself.
		expect(addressAllowed("203.0.113.5", "0.0.0.0/0")).toBe(true);
		expect(addressAllowed("10.0.0.1", "0.0.0.0/0")).toBe(true);
	});

	it("handles a range spanning the high bit", () => {
		// 192.x and above set the top bit, which is where a signed/unsigned mix-up would show.
		expect(addressAllowed("192.168.1.50", "192.168.0.0/16")).toBe(true);
		expect(addressAllowed("192.169.1.50", "192.168.0.0/16")).toBe(false);
	});

	it("matches any one entry in a list", () => {
		expect(addressAllowed("10.0.0.5", "192.168.0.0/16, 10.0.0.0/8")).toBe(true);
	});

	it("refuses the unknown-address sentinel against a non-empty list", () => {
		// `getClientAddress` returns "unknown" when no header identifies the caller. Against a
		// configured allowlist that has to be a refusal: an address nobody can establish is not one
		// anybody put on the list.
		expect(addressAllowed("unknown", "10.0.0.0/8")).toBe(false);
	});

	it("refuses a malformed entry rather than matching everything", () => {
		// A typo in the setting must narrow access, never widen it.
		expect(addressAllowed("10.0.0.1", "not-an-address")).toBe(false);
		expect(addressAllowed("10.0.0.1", "10.0.0.0/99")).toBe(false);
		expect(addressAllowed("10.0.0.1", "10.0.0.300/8")).toBe(false);
	});

	it("refuses an octet with trailing rubbish", () => {
		// `parseInt` reads "10abc" as 10. Checking the digits themselves is what stops that.
		expect(addressAllowed("10abc.0.0.1", "10.0.0.0/8")).toBe(false);
	});

	it("matches an IPv6 address only exactly", () => {
		// IPv6 CIDR is deliberately unsupported; an exact entry still works, and a range entry simply
		// matches nothing rather than matching everything.
		expect(addressAllowed("::1", "::1")).toBe(true);
		expect(addressAllowed("::2", "::1")).toBe(false);
		expect(addressAllowed("::1", "::/0")).toBe(false);
	});
});
