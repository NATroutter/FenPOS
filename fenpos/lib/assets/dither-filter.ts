/**
 * How a dithered raster should be resampled when it is not drawn at one screen pixel per dot.
 *
 * `pixelated` is nearest-neighbour, and nearest-neighbour is right in one direction only. The
 * browser cannot express "crisp when enlarged, averaged when shrunk", so the choice is made here
 * and applied by `components/panel/dithered-image.tsx`.
 */
export type DitherFilter = "auto" | "pixelated";

/** A raster's own size, in the dots the printer will burn. */
type NaturalSize = { widthDots: number; heightDots: number };

/** The size it is laid out at, in CSS pixels. */
type RenderedSize = { widthPx: number; heightPx: number };

/**
 * Picks the filter for a raster drawn at a given size.
 *
 * **Enlarged, the dots are the subject.** At one screen pixel per dot or more, `pixelated` shows
 * each dot as the square the head burns, and smoothing would blur the only thing worth looking at.
 *
 * **Shrunk, the tone is the subject.** A dither is a high-frequency pattern built so that an eye
 * integrates it: at 203 dpi a dot is about 0.125 mm, below what an eye resolves at reading
 * distance, so grey is what the paper *is* rather than something lost in translation. Drawing it
 * smaller means several dots share one pixel, and the two ways to decide that pixel are not
 * equally true — averaging them reproduces the grey the paper shows, while nearest-neighbour keeps
 * one dot and discards the rest. Discarding is sampling below Nyquist, and it returns moiré: a
 * speckle that is neither the dots nor the tone, and that no thermal head could produce.
 *
 * That last point is why this reverses the advice that used to be written here. `pixelated` was
 * chosen to stop the browser blending a dither "back into the greys the dither existed to get rid
 * of" — but the greys are the point of a dither, and below one-to-one `pixelated` does not preserve
 * the speckle, it invents a different one.
 *
 * **Both axes, and the tighter one decides.** A dot dropped along either axis is a dot dropped, so
 * dots are only kept when neither axis is shrunk. Taking the smaller of the two scales is also what
 * makes this correct under `object-fit: contain` without having to know that it is in play: contain
 * fits by the tighter axis, so the smaller scale is the one the image is really drawn at, and a
 * tall raster letterboxed inside a wide box is judged by how small it was drawn rather than by how
 * wide its box happens to be.
 *
 * @param natural the raster's own size, from `naturalWidth` and `naturalHeight`
 * @param rendered the size it is laid out at, from `getBoundingClientRect()`
 * @returns the filter to apply, defaulting to `auto` when any figure is not yet a usable number
 */
export function ditherFilterFor(natural: NaturalSize, rendered: RenderedSize): DitherFilter {
	const figures = [natural.widthDots, natural.heightDots, rendered.widthPx, rendered.heightPx];

	// A raster that has not decoded reports 0, and an element that has not been laid out measures 0.
	// Both mean "not known yet", and the honest default is the one the overwhelming majority of these
	// previews settle on anyway — guessing `pixelated` would flash the static on every first paint.
	if (figures.some((figure) => !Number.isFinite(figure) || figure <= 0)) {
		return "auto";
	}

	const scale = Math.min(rendered.widthPx / natural.widthDots, rendered.heightPx / natural.heightDots);

	return scale >= 1 ? "pixelated" : "auto";
}
