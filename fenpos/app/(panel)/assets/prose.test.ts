import { describe, expect, it } from "vitest";
import { acceptAttributeFor, acceptedFormatsPhrase } from "@/app/(panel)/assets/prose";

/**
 * Both branches of `assets.acceptedFormats`' two values, for both pieces of text the upload dialog
 * builds from it. There are only two values, so "boundary" here means both of them, not an edge of
 * a range.
 */
describe("acceptAttributeFor", () => {
	it("offers both formats when both are accepted", () => {
		expect(acceptAttributeFor("png+jpeg")).toBe("image/png,image/jpeg");
	});

	it("offers only PNG when JPEG is turned off", () => {
		expect(acceptAttributeFor("png")).toBe("image/png");
	});
});

describe("acceptedFormatsPhrase", () => {
	it("names both formats when both are accepted", () => {
		expect(acceptedFormatsPhrase("png+jpeg")).toBe("PNG or JPEG");
	});

	it("names only PNG when JPEG is turned off", () => {
		expect(acceptedFormatsPhrase("png")).toBe("PNG");
	});
});
