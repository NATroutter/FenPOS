import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createAsset } from "@/lib/assets/asset-service";
import { prisma } from "@/lib/db";
import { resolveFonts } from "@/lib/markup/resolve-fonts";

/**
 * Tests for the pre-pass that hands the compiler the faces a receipt names.
 *
 * The same shape as the image pre-pass and for the same reason: loading a face is a database read
 * and compiling is synchronous, so the waiting happens once, before the compile, and the answers
 * reach it through `CompileSettings`.
 */
const FONT = readFileSync(path.join(process.cwd(), "public/fonts/DejaVuSansMono.ttf"));

describe("resolveFonts", () => {
	beforeEach(async () => {
		await prisma.asset.deleteMany();
	});

	it("loads every configured font the document names, once", async () => {
		await createAsset("mono", FONT);
		const fonts = await resolveFonts("<text font=mono>a</text>\n<text font=mono size=30>b</text>", null, {});

		expect([...fonts.keys()]).toEqual(["mono"]);
	});

	it("ignores the built-in fonts", async () => {
		expect((await resolveFonts("<text font=a>x</text><text font=b>y</text>", null, {})).size).toBe(0);
	});

	it("reports an unknown font with its line and column", async () => {
		await expect(resolveFonts("ok\n<text font=nobody>x</text>", null, {})).rejects.toMatchObject({
			code: "unknown_font",
			details: { line: 2, column: 1, detail: "nobody" },
		});
	});

	it("skips a document that does not parse", async () => {
		expect((await resolveFonts("<bold>", null, {})).size).toBe(0);
	});
});
