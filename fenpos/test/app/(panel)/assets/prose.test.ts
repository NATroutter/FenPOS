import { describe, expect, it } from "vitest";
import {
	acceptAttributeFor,
	acceptedFormatsPhrase,
	assetStoredMessage,
	replaceDescription,
} from "@/app/(panel)/assets/prose";

/**
 * Both branches of `assets.acceptedFormats`' two values, for both pieces of text the upload dialog
 * builds from it. There are only two values, so "boundary" here means both of them, not an edge of
 * a range. Both are asked for alongside a font, because the File tab accepts one of each kind
 * whatever `assets.acceptedFormats` says about images — that setting narrows image formats, not
 * whether a font may be chosen.
 */
describe("acceptAttributeFor", () => {
	it("offers both image formats and both font flavours when both images are accepted", () => {
		expect(acceptAttributeFor("png+jpeg")).toBe("image/png,image/jpeg,.ttf,.otf,font/ttf,font/otf");
	});

	it("offers only PNG and both font flavours when JPEG is turned off", () => {
		expect(acceptAttributeFor("png")).toBe("image/png,.ttf,.otf,font/ttf,font/otf");
	});
});

describe("acceptedFormatsPhrase", () => {
	it("names both image formats and fonts when both images are accepted", () => {
		expect(acceptedFormatsPhrase("png+jpeg")).toBe("PNG or JPEG images, and TTF or OTF fonts");
	});

	it("names only PNG and fonts when JPEG is turned off", () => {
		expect(acceptedFormatsPhrase("png")).toBe("PNG images, and TTF or OTF fonts");
	});
});

describe("assetStoredMessage", () => {
	it("names a font", () => {
		expect(assetStoredMessage("roboto", "FONT")).toBe("roboto stored as a font.");
	});

	it("names an image", () => {
		expect(assetStoredMessage("logo", "IMAGE")).toBe("logo stored as an image.");
	});
});

/**
 * Every branch `replaceDescription` can take: both accepted-formats values for an image, and the
 * font branch, which does not consult `assets.acceptedFormats` at all. Pinned separately from
 * `acceptedFormatsPhrase` because this function deliberately never mentions the other kind — see its
 * own doc comment.
 */
describe("replaceDescription", () => {
	it("names both image formats, for an image, when both are accepted", () => {
		expect(replaceDescription("IMAGE", "png+jpeg", 2 * 1024 * 1024)).toBe(
			"PNG or JPEG images, up to 2 MiB. The name stays as it is, so every receipt that already prints this image prints the new one without being edited.",
		);
	});

	it("names only PNG, for an image, when JPEG is turned off", () => {
		expect(replaceDescription("IMAGE", "png", 2 * 1024 * 1024)).toBe(
			"PNG images, up to 2 MiB. The name stays as it is, so every receipt that already prints this image prints the new one without being edited.",
		);
	});

	it("names a font without mentioning images, regardless of assets.acceptedFormats", () => {
		expect(replaceDescription("FONT", "png+jpeg", 5 * 1024 * 1024)).toBe(
			"A TTF or OTF font, up to 5 MiB. The name stays as it is, so every receipt that already draws this font draws the new one without being edited.",
		);
	});
});
