import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeImage, ditherToRaster, type ImageRaster } from "@/lib/assets/dither";
import { ApiError } from "@/lib/errors";

/**
 * The application's own logo, resolved for the panel the way the agent resolves it for the printer.
 *
 * **Why this is not an asset.** The device test page prints this logo, and a diagnostic that stops
 * working because someone tidied their Assets tab is a bad diagnostic — so the logo ships with the
 * software on both sides: inside the agent's jar as pre-dithered rasters, and here as the PNG in
 * `public/`. The name is reserved (`RESERVED_ASSET_NAME` in `asset-service.ts`) so no row can ever
 * be created under it, which is what keeps the two answers from ever being two.
 *
 * **Why it may read from disk when nothing else here does.** This is the only image in the system
 * whose source is a file rather than a database row or a URL, and it is safe for exactly one
 * reason: the path is a constant. {@link isBundledLogo} matches one whole string, so no reference
 * an operator writes — not `fenpos/logo`, not `../.env`, not `FenPOS` — reaches
 * {@link bundledLogoRaster} at all. There is no name-to-path construction here to be traversed, and
 * a URL never arrives: `resolve-images.ts` sends anything containing `://` to the fetch guard
 * before this is consulted.
 *
 * **Why the dots are dithered here rather than read from the agent's rasters.** Nothing in the
 * panel can reach the agent's jar, and copying its `.raster` files into this package would give the
 * repository two committed copies of the same dots to keep in step. Dithering the same PNG through
 * the same {@link ditherToRaster} produces the same bits — and `bundled-logo.test.ts` decodes the
 * agent's committed files and asserts exactly that, so the agreement is checked rather than
 * assumed.
 */

/**
 * The reserved name, and the only reference this module answers for.
 *
 * `RESERVED_ASSET_NAME` in `asset-service.ts` is this constant, so the name the asset store refuses
 * and the name resolved here cannot drift apart. It is also `BundledImages.NAME` on the agent, which
 * `markup-tool.test.ts` compares across the two languages.
 */
export const BUNDLED_LOGO_NAME = "fenpos";

/**
 * The printed widths, in dots, the logo may be resolved at.
 *
 * **These are the agent's bundled widths and must stay identical to `BUNDLED_WIDTHS` in
 * `scripts/bundle-logo-rasters.ts`**, which is what wrote the agent's rasters. 384, 504 and 576 are
 * 32, 42 and 48 columns: the two standard thermal papers and the column count a device is created
 * with.
 *
 * The panel could dither any width on demand — it holds the PNG and the ditherer. It deliberately
 * does not, because a preview is only worth having if it shows what the paper will show, and
 * `BundledImages.forDevice` matches a width *exactly* and never scales. A preview at 252 dots would
 * be a picture of something no printer in this system can produce.
 */
export const BUNDLED_LOGO_WIDTHS: readonly number[] = [384, 504, 576];

/** The image dithered. The application's own logo, which is why it may ship inside the software. */
const SOURCE = path.join(process.cwd(), "public", "fenpos-logo.png");

/**
 * Whether a reference names the bundled logo.
 *
 * Matched whole and case-sensitively, which is the guard rather than a formality: this is the one
 * predicate standing between a reference an operator typed and a filesystem read.
 *
 * @param reference the text between the `<image>` tags
 * @returns true only for the reserved name itself
 */
export function isBundledLogo(reference: string): boolean {
	return reference === BUNDLED_LOGO_NAME;
}

/**
 * The logo's size in pixels as it is stored, resolved once and remembered.
 *
 * Kept as two numbers rather than as the decode, so nothing holds a bitmap for the life of the
 * process. It is the image's own size — the one thing about it that does not depend on the paper —
 * which is what `imageGeometry` measures a printed height from.
 */
let dimensions: Promise<{ width: number; height: number }> | undefined;

/** One raster per bundled width, so a receipt repeating the logo dithers it once per process. */
const rasters = new Map<number, Promise<ImageRaster>>();

/**
 * The logo's own pixel dimensions.
 *
 * @returns the size of `public/fenpos-logo.png`
 */
export async function bundledLogoSize(): Promise<{ width: number; height: number }> {
	dimensions ??= readFile(SOURCE)
		.then(decodeImage)
		.then((decoded) => ({ width: decoded.width, height: decoded.height }));

	// A failed read must not be remembered as the answer for the rest of the process: the file
	// being briefly unreadable is a different thing from it being wrong.
	dimensions.catch(() => {
		dimensions = undefined;
	});

	return dimensions;
}

/**
 * Dithers the logo at one printed width.
 *
 * Memoised per width, and bounded by {@link BUNDLED_LOGO_WIDTHS} because nothing else is dithered:
 * at most three rasters, whatever a receipt asks for.
 *
 * @param widthDots the printed width, from `printedWidthDots`
 * @returns the dots, byte for byte what the agent has bundled for that width
 * @throws ApiError if the agent bundles nothing for that width
 */
export async function bundledLogoRaster(widthDots: number): Promise<ImageRaster> {
	if (!BUNDLED_LOGO_WIDTHS.includes(widthDots)) {
		throw new ApiError(
			"unbundled_logo_width",
			`'${BUNDLED_LOGO_NAME}' is the application's own logo and is bundled only at ${BUNDLED_LOGO_WIDTHS.join(", ")} dots — 32, 42 and 48 columns at the paper's full width. This asks for ${widthDots} dots, which no printer here could be sent. Print it at the full width of a printer with one of those column counts, or upload your own image on the Assets tab.`,
			{ widthDots, bundled: [...BUNDLED_LOGO_WIDTHS] },
		);
	}

	const remembered = rasters.get(widthDots);
	if (remembered) {
		return remembered;
	}

	const dithering = readFile(SOURCE).then((bytes) => ditherToRaster(bytes, widthDots));
	rasters.set(widthDots, dithering);
	dithering.catch(() => {
		if (rasters.get(widthDots) === dithering) {
			rasters.delete(widthDots);
		}
	});

	return dithering;
}
