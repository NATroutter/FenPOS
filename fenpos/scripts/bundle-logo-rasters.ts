import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ditherToRaster, type ImageRaster } from "../lib/assets/dither";

/**
 * Dithers the FenPOS logo at each paper width the agent bundles, and writes the rasters into the
 * agent's resources.
 *
 * Usage:
 *   pnpm agent:bundle-logo
 *
 * **Why this exists.** The device test page prints the application's own logo, and that logo must
 * not be an `Asset`: an asset is the user's content, deletable from the Assets tab, and a
 * diagnostic that stops working because someone tidied their asset library is a bad diagnostic.
 * So the logo ships inside the agent instead.
 *
 * **Why that does not break the rule that the server owns all encoding.** The agent has no
 * ditherer and gets none here. The objection the design actually makes is to *downscaling an
 * already-dithered raster* — resampling dots that have been reduced to black and white resamples
 * the dither's own noise and turns a picture into mud. It is not an objection to holding several
 * rasters. So this dithers once per bundled width, through the very same {@link ditherToRaster}
 * the upload path uses, and the agent picks the one whose width matches exactly. No agent-side
 * resampling happens, because no agent-side resampling is ever needed.
 *
 * Running the real ditherer rather than a copy of it is the point of this script. The bundled bits
 * are then, byte for byte, what the server would have synced for the same image at the same width,
 * so the logo the test page prints and a logo an operator uploads are dithered by one algorithm.
 *
 * **Idempotent.** Re-running produces identical bytes and rewrites nothing that has not changed;
 * a raster for a width no longer in {@link BUNDLED_WIDTHS} is deleted, so the directory is exactly
 * what this script says it should be. The output is committed, because the agent must build with
 * Maven alone and nobody building it should need this package's toolchain.
 */

/**
 * The paper widths bundled, in printer dots.
 *
 * `columns` is validated as 1–255, so `columns × 12` spans 12–3060 dots and bundling every
 * possibility is not on the table — the set has to be chosen. These three are 32, 42 and 48
 * columns: the two standard thermal widths (58 mm is 384 dots, 80 mm is 576) and 42, which is the
 * column count a device is created with in `device-service.ts`. They are also the widths of the
 * devices this install runs.
 *
 * Nothing else is bundled on purpose. Every extra width is bytes in the jar for a paper size
 * nobody here has evidence of anyone using, and a width that is not bundled is not a failure: the
 * test page simply prints one block fewer. Add a width when a device turns up that needs it.
 */
const BUNDLED_WIDTHS = [384, 504, 576] as const;

/** The image dithered. The application's own logo, which is why it may ship inside the agent. */
const SOURCE = path.join(__dirname, "..", "public", "fenpos-logo.png");

/** Where the agent reads them from, as a classpath resource directory. */
const OUT_DIR = path.join(__dirname, "..", "..", "agent", "src", "main", "resources", "bundled");

/** The basename every bundled raster shares, before its width. Mirrors `BundledImages.java`. */
const PREFIX = "fenpos-logo-";

/** The extension every bundled raster has. Mirrors `BundledImages.java`. */
const SUFFIX = ".raster";

/**
 * The format's magic and version, on a line of its own.
 *
 * A file that does not start with this is not one of these, and a later format change takes a new
 * number rather than being guessed at from the contents.
 */
const MAGIC = "FPR1";

/** Base64 wrap column. Long enough to stay compact, short enough that a diff is readable. */
const WRAP = 76;

/**
 * Renders a raster in the bundled format.
 *
 * **Text, not binary, and not by preference.** `agent/pom.xml` filters the whole of
 * `src/main/resources` (`<filtering>true</filtering>`), which copies every resource through the
 * property substituter as text — `build.properties` needs that, and the pom is not this change's
 * to alter. Filtering a binary file corrupts it. The repository's `.gitattributes` normalises every
 * tracked file to LF for the same "nothing here is binary" reason. Base64 survives both: its
 * alphabet contains neither of Maven's `${…}` and `@…@` delimiters, and it is invariant under every
 * ASCII-compatible encoding the filter might pick.
 *
 * The format is three parts, each on its own line or lines:
 *
 * ```
 * FPR1
 * <widthDots> <heightDots>
 * <base64 of the packed dots, wrapped>
 * ```
 *
 * Width and height are stated rather than inferred, because the packed length only ever gives the
 * height back if the width is already known and the row padding is assumed — so the reader can
 * check the three against each other instead of trusting one of them. The dots are exactly
 * `ImageRaster.packed`: one bit per dot, most significant bit leftmost, each row padded to a whole
 * byte, a set bit meaning ink.
 *
 * @param raster what `ditherToRaster` produced
 * @returns the file's contents, LF-terminated
 */
function render(raster: ImageRaster): string {
	const base64 = raster.packed.toString("base64");
	const lines = [MAGIC, `${raster.widthDots} ${raster.heightDots}`];
	for (let at = 0; at < base64.length; at += WRAP) {
		lines.push(base64.slice(at, at + WRAP));
	}
	return `${lines.join("\n")}\n`;
}

/** Writes a file only when its contents would change, so a re-run is genuinely a no-op. */
function writeIfChanged(file: string, contents: string): "written" | "unchanged" {
	try {
		if (readFileSync(file, "utf8") === contents) {
			return "unchanged";
		}
	} catch {
		// Absent, which is a write rather than a failure.
	}
	writeFileSync(file, contents, "utf8");
	return "written";
}

/** Removes rasters for widths no longer bundled, so the directory cannot accumulate stale ones. */
function removeStale(keep: ReadonlySet<string>): void {
	for (const entry of readdirSync(OUT_DIR)) {
		if (entry.startsWith(PREFIX) && entry.endsWith(SUFFIX) && !keep.has(entry)) {
			rmSync(path.join(OUT_DIR, entry));
			process.stdout.write(`  removed ${entry}\n`);
		}
	}
}

async function main(): Promise<void> {
	const bytes = readFileSync(SOURCE);
	mkdirSync(OUT_DIR, { recursive: true });

	const written = new Set<string>();
	for (const widthDots of BUNDLED_WIDTHS) {
		const raster = await ditherToRaster(bytes, widthDots);
		const name = `${PREFIX}${raster.widthDots}${SUFFIX}`;
		written.add(name);
		const state = writeIfChanged(path.join(OUT_DIR, name), render(raster));
		process.stdout.write(`  ${state === "written" ? "wrote" : "kept"} ${name} `);
		process.stdout.write(`(${raster.widthDots}x${raster.heightDots}, ${raster.packed.length} bytes of dots)\n`);
	}
	removeStale(written);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
