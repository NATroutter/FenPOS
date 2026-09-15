import { describe, expect, it } from "vitest";
import { acceptAttributeFor, acceptedFormatsPhrase, assetStoredMessage } from "@/app/(panel)/assets/prose";

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
