import { describe, expect, it } from "vitest";
import { avatarInitial } from "@/lib/auth/avatar";

/**
 * Tests for the avatar's derivation.
 */

describe("avatarInitial", () => {
	it("takes the first character, uppercased", () => {
		expect(avatarInitial("NATroutter")).toBe("N");
		expect(avatarInitial("administrator")).toBe("A");
	});

	it("ignores leading space", () => {
		expect(avatarInitial("  kim")).toBe("K");
	});

	/** A name is operator-supplied text, and one character of it may be more than one code unit. */
	it("takes a whole character, not half a surrogate pair", () => {
		expect(avatarInitial("😀 shop")).toBe("😀");
	});

	it("falls back to a letter rather than rendering an empty circle", () => {
		expect(avatarInitial("")).toBe("A");
		expect(avatarInitial("   ")).toBe("A");
	});
});
