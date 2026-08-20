import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ditherToRaster } from "@/lib/assets/dither";

/**
 * That the rasters committed into the agent are the ones this server would have produced.
 *
 * The bundled logo only earns its exemption from "the server owns all encoding" if its bits are
 * the server's bits. If they are not — a hand-edited file, a stale commit, a logo changed without
 * re-running `pnpm agent:bundle-logo` — then the agent is shipping a picture dithered by something
 * else, and a logo printed from the test page and the same logo uploaded as an asset would come off
 * the paper differently. So this re-runs the real ditherer over the real source and compares.
 *
 * It also reads the committed files exactly as `BundledImages.java` does, which is the only check
 * on this side that the format survives being written, committed and read back.
 */

/** Where the committed rasters live, from this package's root. */
const BUNDLED = path.join("..", "agent", "src", "main", "resources", "bundled");

/** The image they are dithered from. */
const SOURCE = readFileSync(path.join("public", "fenpos-logo.png"));

/** The widths the agent must be able to print the logo at, whatever else is committed. */
const REQUIRED_WIDTHS = [384, 504, 576];

/** Every committed raster, by the width its name declares. */
function committed(): { file: string; widthDots: number }[] {
	return readdirSync(BUNDLED)
		.filter((file) => file.endsWith(".raster"))
		.map((file) => ({ file, widthDots: Number(file.replace(/\D+/g, "")) }));
}

/** Reads one, the way the agent reads it: magic, then a size line, then wrapped base64. */
function read(file: string): { widthDots: number; heightDots: number; packed: Buffer } {
	const lines = readFileSync(path.join(BUNDLED, file), "utf8").split("\n");
	expect(lines[0], `${file} does not start with the format's magic`).toBe("FPR1");
	const [widthDots, heightDots] = lines[1].split(" ").map(Number);
	return { widthDots, heightDots, packed: Buffer.from(lines.slice(2).join(""), "base64") };
}

describe("the bundled logo rasters", () => {
	it("covers every width the agent needs", () => {
		const widths = committed().map((entry) => entry.widthDots);

		for (const width of REQUIRED_WIDTHS) {
			expect(widths, `nothing bundled for ${width} dots`).toContain(width);
		}
	});

	it.each(committed())("holds exactly what ditherToRaster produces at $widthDots dots", async ({ file, widthDots }) => {
		const stored = read(file);
		const fresh = await ditherToRaster(SOURCE, widthDots);

		expect(stored.widthDots).toBe(fresh.widthDots);
		expect(stored.heightDots).toBe(fresh.heightDots);
		// Compared as bits rather than as a hash, so a failure says which byte and not merely that
		// something differs.
		expect(stored.packed.equals(fresh.packed)).toBe(true);
	});

	it.each(committed())("states a size its dots agree with in $file", ({ file }) => {
		const stored = read(file);

		// The same arithmetic `Directive.Image` applies on the agent, checked here so a bad commit
		// fails in this suite rather than behind a printer.
		expect(stored.packed.length).toBe(Math.ceil(stored.widthDots / 8) * stored.heightDots);
	});
});
