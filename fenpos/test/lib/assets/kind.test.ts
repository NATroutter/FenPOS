import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectAssetKind } from "@/lib/assets/kind";

/**
 * Tests for what a file turns out to be.
 *
 * The whole point is that the answer comes from the bytes rather than from a filename or a
 * client-supplied content type: both are the caller's to choose, and a font stored as an image
 * would be dithered on every agent connect.
 */

describe("detectAssetKind", () => {
	it("recognises a PNG and a TrueType font", () => {
		expect(detectAssetKind(readFileSync(path.join(process.cwd(), "test/fixtures/logo.png")))).toEqual({
			kind: "IMAGE",
		});
		expect(detectAssetKind(readFileSync(path.join(process.cwd(), "public/fonts/DejaVuSansMono.ttf")))).toEqual({
			kind: "FONT",
			mimeType: "font/ttf",
		});
	});

	it("recognises a CFF font by its OTTO tag and refuses anything else", () => {
		expect(detectAssetKind(Buffer.from("OTTO\0\0\0\0"))).toEqual({ kind: "FONT", mimeType: "font/otf" });
		expect(detectAssetKind(Buffer.from("hello"))).toBeNull();
		expect(detectAssetKind(Buffer.alloc(0))).toBeNull();
	});
});
