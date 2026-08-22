import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_LOGO_NAME, BUNDLED_LOGO_WIDTHS, bundledLogoRaster, isBundledLogo } from "@/lib/assets/bundled-logo";
import { ApiError } from "@/lib/errors";

/**
 * That the logo this panel resolves is, dot for dot, the logo the agent prints.
 *
 * The panel previews `<image>fenpos</image>` by dithering `public/fenpos-logo.png`; the agent
 * prints it from a raster committed into its own resources by `pnpm agent:bundle-logo`. Both start
 * from the same PNG and run the same `ditherToRaster`, so they *should* agree — but "should" is
 * exactly the word a preview may not rest on. A preview showing a different dither from the paper
 * is worse than the `unknown_asset` it replaced, because that error was at least honest.
 *
 * So this decodes the committed files and compares them against what this module resolves. It is
 * also the staleness guard: change the logo, forget to re-run the bundler, and this fails rather
 * than the two sides quietly drifting apart. `test/scripts/bundle-logo-rasters.test.ts` makes the same
 * comparison one step earlier, against `ditherToRaster` directly; this one is about the path the
 * panel actually takes to those dots, including its cache.
 */

/** Where the agent's committed rasters live, from this package's root. */
const BUNDLED = path.join("..", "agent", "src", "main", "resources", "bundled");

/** Reads one the way `BundledImages.java` does: magic, then a size line, then wrapped base64. */
function committed(widthDots: number): { widthDots: number; heightDots: number; packed: Buffer } {
	const lines = readFileSync(path.join(BUNDLED, `fenpos-logo-${widthDots}.raster`), "utf8").split("\n");
	expect(lines[0]).toBe("FPR1");
	const [width, height] = lines[1].split(" ").map(Number);
	return { widthDots: width, heightDots: height, packed: Buffer.from(lines.slice(2).join(""), "base64") };
}

describe("the bundled logo", () => {
	it.each([...BUNDLED_LOGO_WIDTHS])("resolves at %i dots exactly what the agent has bundled", async (widthDots) => {
		const stored = committed(widthDots);
		const resolved = await bundledLogoRaster(widthDots);

		expect(resolved.widthDots).toBe(stored.widthDots);
		expect(resolved.heightDots).toBe(stored.heightDots);
		// Compared as bits rather than as a hash, so a failure says which byte and not merely that
		// something differs.
		expect(resolved.packed.equals(stored.packed)).toBe(true);
	});

	/**
	 * The agent matches a bundled width exactly and never scales — `BundledImages.forDevice` returns
	 * an empty resolver otherwise. The panel could dither any width on demand, and that is precisely
	 * why it must not: a preview at 252 dots would show a picture the agent has no way to print.
	 */
	it("refuses a width the agent bundles nothing for, and says which widths it has", async () => {
		const thrown = await bundledLogoRaster(252).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).code).toBe("unbundled_logo_width");
		for (const width of BUNDLED_LOGO_WIDTHS) {
			expect((thrown as ApiError).message).toContain(String(width));
		}
	});

	/**
	 * The reserved name is the only string that may reach the filesystem here, so it is matched
	 * whole and case-sensitively. Anything looser and a reference an operator wrote would decide
	 * which file this server opens.
	 */
	it("answers for the reserved name and for nothing else", () => {
		expect(isBundledLogo(BUNDLED_LOGO_NAME)).toBe(true);

		for (const near of [
			"FenPOS",
			"fenpos ",
			" fenpos",
			"fenpos-logo",
			"fenpos/logo",
			"../public/fenpos-logo.png",
			"",
		]) {
			expect(isBundledLogo(near), `${near} must not be treated as the logo`).toBe(false);
		}
	});

	it("gives the logo's own pixel size, which is what the compiler measures height from", async () => {
		const raster = await bundledLogoRaster(384);
		const wider = await bundledLogoRaster(576);

		// Same picture at two widths: the aspect ratio has to survive, or the preview's height and
		// the paper's would come apart on one of them.
		expect(raster.heightDots / raster.widthDots).toBeCloseTo(wider.heightDots / wider.widthDots, 1);
	});
});
