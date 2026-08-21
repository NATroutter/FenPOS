import "server-only";
import { Jimp, JimpMime } from "jimp";
import type { ImageRaster } from "@/lib/assets/dither";

/**
 * Showing a printer's own raster on a screen.
 *
 * The Assets tab has to show what the printer will put on paper, not what was uploaded. Those are
 * different pictures: the printer has one ink and no greys, so a photograph reaches it as speckle,
 * and an operator who is shown the smooth original has been shown something that will never exist.
 * The whole reason `dither.ts` runs server-side is that the panel and the printer can then be
 * looking at the same bits.
 *
 * So this module converts a finished {@link ImageRaster} — 1 bit per dot, MSB first, rows padded to
 * whole bytes — into a PNG data URI an `<img>` can carry. It re-decides nothing. Dithering on the
 * client would produce a second answer to a question that already has one, and the two would drift
 * the first time either side changed.
 *
 * Separate from `dither.ts` because that module is the print path's raster producer and is the
 * single point of contact with jimp's *decoder*; this is the panel's, and only encodes. Nothing on
 * the print path calls it.
 */

/**
 * Renders a 1-bit raster as a PNG data URI.
 *
 * **Greyscale rather than colour, deliberately.** The raster is black and white, and PNG's
 * `colorType: 0` stores one channel instead of four. Measured on this codebase with `test/fixtures/
 * logo.png` dithered to 384 dots: 30,274 bytes as RGBA against 9,690 as greyscale, and the bytes
 * are inlined into the page's HTML once per asset, so the difference is paid on every render of the
 * tab rather than once.
 *
 * A data URI rather than a route that serves the bytes: the raster is derived at render anyway, and
 * an endpoint would be a second thing to guard with a session. Same shape as `SymbolPreview`, which
 * inlines its SVG for the same reason.
 *
 * The image is drawn at one screen pixel per printer dot. Fitting it into a card is the caller's
 * business — and a caller that scales it should hand it to `components/panel/dithered-image.tsx`
 * rather than pick a filter itself, because the right filter depends on which way it scaled. Drawn
 * at one-to-one or larger the dots are the subject and want `pixelated`; drawn smaller the tone is,
 * and nearest-neighbour throws away most of the dots and returns moiré. `ditherFilterFor` carries
 * the full reasoning.
 *
 * @param raster a dithered raster, from `ditherToRaster` or `rasterFor`
 * @returns a `data:image/png;base64,…` URI of the same dots
 */
export async function rasterToPngDataUrl(raster: ImageRaster): Promise<string> {
	const { widthDots, heightDots, packed } = raster;

	// Starts as paper, so only inked dots are written below.
	const image = new Jimp({ width: widthDots, height: heightDots, color: 0xffffffff });
	const rowBytes = Math.ceil(widthDots / 8);
	const pixels = image.bitmap.data;

	for (let y = 0; y < heightDots; y++) {
		for (let x = 0; x < widthDots; x++) {
			// The same packing `floydSteinberg` wrote: leftmost dot of a row is bit 7 of its first
			// byte, and a set bit is ink. Reading it back the other way round would show every
			// image mirrored in eight-dot blocks, which is subtle enough to ship unnoticed.
			if ((packed[y * rowBytes + (x >> 3)] & (0x80 >> (x % 8))) === 0) {
				continue;
			}
			const at = (y * widthDots + x) * 4;
			pixels[at] = 0;
			pixels[at + 1] = 0;
			pixels[at + 2] = 0;
		}
	}

	const png = await image.getBuffer(JimpMime.png, { colorType: 0 });
	return `data:image/png;base64,${png.toString("base64")}`;
}
