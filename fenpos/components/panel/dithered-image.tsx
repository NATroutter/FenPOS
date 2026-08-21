"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { type DitherFilter, ditherFilterFor } from "@/lib/assets/dither-filter";

/**
 * A dithered raster, resampled the way its drawn size deserves.
 *
 * **Nothing about the image is decided here.** The PNG is the finished 1-bit raster and the box it
 * sits in is the caller's; this component's whole job is to answer the one question CSS cannot,
 * which is whether the browser should average the dots or keep them. `ditherFilterFor` holds the
 * rule and the reasoning behind it.
 *
 * The size is measured rather than assumed because both surfaces that use this are fluid: the
 * Assets card follows the grid, and the Tools sheet follows the panel. A raster is usually drawn
 * smaller than its dots and wants averaging, but a small stored image is stretched up to the card's
 * width and wants the dots kept, and which of those is true changes with the viewport.
 */
export function DitheredImage({
	src,
	alt,
	className,
	style,
}: {
	/** The dithered raster, as a data URI. */
	src: string;
	alt: string;
	className?: string;
	style?: CSSProperties;
}) {
	const ref = useRef<HTMLImageElement>(null);
	// `auto` until measured. See `ditherFilterFor`: it is the answer nearly every one of these
	// settles on, so starting there means first paint is not a frame of the wrong picture.
	const [filter, setFilter] = useState<DitherFilter>("auto");

	useEffect(() => {
		const image = ref.current;
		if (!image) {
			return;
		}

		const measure = () => {
			const box = image.getBoundingClientRect();
			setFilter(
				ditherFilterFor(
					{ widthDots: image.naturalWidth, heightDots: image.naturalHeight },
					{ widthPx: box.width, heightPx: box.height },
				),
			);
		};

		measure();

		// Remeasured on resize because the ratio that decides this is between the raster's fixed
		// width and a layout width that is not fixed at all.
		const observer = new ResizeObserver(measure);
		observer.observe(image);

		// `naturalWidth` reads 0 until the image decodes. A data URI usually beats this effect, but
		// "usually" would leave the occasional card smoothing a raster it should have kept crisp.
		image.addEventListener("load", measure);

		return () => {
			observer.disconnect();
			image.removeEventListener("load", measure);
		};
	}, []);

	return (
		/** biome-ignore lint/performance/noImgElement: a data URI is already inlined; there is nothing for the image pipeline to optimise. */
		<img ref={ref} src={src} alt={alt} className={className} style={{ ...style, imageRendering: filter }} />
	);
}
