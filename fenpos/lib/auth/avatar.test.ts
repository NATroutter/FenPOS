import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { avatarInitial, gravatarUrl } from "@/lib/auth/avatar";

/**
 * Tests for the avatar's two derivations.
 *
 * The hash is checked against one computed here rather than against a copied literal: a literal
 * would pass just as well if the implementation hashed the wrong string, since both sides would
 * have been written from the same wrong idea.
 */

/** What Gravatar specifies: SHA-256 of the trimmed, lowercased address. */
function expectedHash(email: string): string {
	return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

describe("gravatarUrl", () => {
	it("hashes the address with SHA-256", () => {
		expect(gravatarUrl("me@natroutter.fi")).toContain(expectedHash("me@natroutter.fi"));
	});

	it("normalises case and surrounding space before hashing", () => {
		const canonical = gravatarUrl("me@natroutter.fi");

		expect(gravatarUrl("  ME@NatRoutter.FI  ")).toBe(canonical);
	});

	/**
	 * Without `d=404` Gravatar generates an image for a hash it has never seen, so an operator
	 * whose address has no Gravatar account gets a procedural blob instead of their own initial.
	 * The 404 is what makes the image fail, which is what makes the fallback run.
	 */
	it("asks Gravatar to refuse rather than generate an unknown avatar", () => {
		expect(gravatarUrl("me@natroutter.fi")).toContain("d=404");
	});

	it("returns null when there is no address, so nothing is requested at all", () => {
		expect(gravatarUrl(null)).toBeNull();
		expect(gravatarUrl("")).toBeNull();
		expect(gravatarUrl("   ")).toBeNull();
	});

	it("points at gravatar.com over https", () => {
		expect(gravatarUrl("me@natroutter.fi")).toMatch(/^https:\/\/gravatar\.com\/avatar\//);
	});
});

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
