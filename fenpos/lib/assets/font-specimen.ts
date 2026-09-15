import "server-only";
import { rasterToPngDataUrl } from "@/lib/assets/preview";
import { PLAIN } from "@/lib/markup/model";
import { Canvas } from "@/lib/raster/canvas";
import { typefaceFor } from "@/lib/raster/fonts";
import type { FontFace } from "@/lib/raster/glyphs";
import { layoutText, paintRows, textHeight } from "@/lib/raster/text";

/**
 * A font's own preview: the one thing every card on the Assets tab shows before an operator reads a
 * single letter of its name.
 *
 * An image's card shows the dithered picture, because that is the whole reason an operator opens it —
 * to judge how a logo survives being reduced to one ink. A font has no picture until it draws
 * something, so the card draws the same sentence every face gets, at the card's own preview width, in
 * exactly the pipeline a receipt would use: {@link layoutText} lays it out, {@link paintRows} paints
 * it, and {@link rasterToPngDataUrl} turns the result into the same kind of data URI the image cards
 * already carry.
 */

/**
 * What every font's specimen renders. Holds every letter of the Latin alphabet in both cases and
 * every digit, which is the smallest sentence that shows whether a face is missing anything an
 * ordinary receipt would ask it to draw.
 */
export const SPECIMEN_TEXT = "The quick brown fox jumps over the lazy dog 0123456789";

/** The em size the specimen is drawn at. Large enough on screen to read, one printed size among many. */
const SPECIMEN_DOTS = 24;

/**
 * Renders a font's specimen as a PNG data URI, wrapped to a paper width.
 *
 * **`REPLACE`, never `REJECT`.** A card is shown for every stored font, including one an operator
 * uploaded by mistake and is about to delete — a glyph the face lacks must not turn the whole card
 * into a thrown error. The `?` `REPLACE` stands in for is a legible answer to "what is missing", and
 * the sentence is fixed and Latin, so a genuinely usable face has no gaps to substitute in the first
 * place.
 *
 * @param face the parsed font, from `fontFace` (`asset-service.ts`) or `bundledFace` (`raster/fonts.ts`)
 * @param widthDots the paper width to wrap the specimen to, in printer dots
 * @returns a `data:image/png;base64,…` URI of the rendered specimen
 */
export async function fontSpecimenPngDataUrl(face: FontFace, widthDots: number): Promise<string> {
	const rows = layoutText(
		[{ kind: "run", text: SPECIMEN_TEXT, style: { ...PLAIN, face: "specimen", faceDots: SPECIMEN_DOTS }, column: 1 }],
		widthDots,
		true,
		"LEFT",
		{
			typeface: () => typefaceFor(face, SPECIMEN_DOTS),
			onUnsupported: "REPLACE",
			codepage: "CP437",
		},
	);

	const canvas = new Canvas(widthDots, textHeight(rows));
	paintRows(canvas, rows, 0, 0);
	return rasterToPngDataUrl(canvas.pack());
}
