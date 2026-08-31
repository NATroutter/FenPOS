"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A round portrait that always renders something.
 *
 * The fallback is the point rather than a nicety. Every way this can go wrong — the stored render
 * having been deleted since the page that named it was rendered, a network hiccup, a stale URL —
 * arrives as the same load failure, and without a fallback each of them is a broken image in the
 * corner of every page. `src` being null is the other case: no avatar is stored, so nothing is
 * requested at all.
 *
 * A client component because it holds one piece of state: whether the image failed.
 */
export function Avatar({
	src,
	initial,
	className,
}: {
	/** The image to try, or null to go straight to the initial. */
	src: string | null;
	/** Drawn when there is no image, or the image did not load. */
	initial: string;
	className?: string;
}) {
	const [failed, setFailed] = useState(false);
	const imageRef = useRef<HTMLImageElement>(null);

	// The image is rendered on the server, so the browser starts fetching it before React has
	// hydrated and attached `onError`. A request that fails inside that window fires its error
	// event into the void: the picture is broken on screen and this component never hears about
	// it — which is the exact case it exists for, and the case an install with no internet hits
	// on every single load. An image that is `complete` with no intrinsic width is one that has
	// already finished failing, so that is what this looks for.
	//
	// Keyed on `src` so a new address gets a fresh attempt rather than inheriting the last one's
	// verdict.
	useEffect(() => {
		setFailed(false);

		const image = imageRef.current;
		if (image?.complete && image.naturalWidth === 0) {
			setFailed(true);
		}
	}, [src]);

	const showImage = src !== null && !failed;

	return (
		<span
			className={cn(
				"relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted",
				className,
			)}
		>
			{showImage ? (
				// A plain <img>, not next/image. The optimiser fetches through the server, which would
				// move the request off the operator's browser and defeat the failure this component
				// exists to catch — the server always has the stored bytes, so it would report success
				// even for a browser that could not actually reach the route.
				// biome-ignore lint/performance/noImgElement: the load must happen in the browser
				<img
					ref={imageRef}
					src={src}
					alt=""
					className="size-full object-cover"
					referrerPolicy="no-referrer"
					onError={() => setFailed(true)}
				/>
			) : (
				<span aria-hidden className="font-medium text-[13px] text-muted-foreground select-none">
					{initial}
				</span>
			)}
		</span>
	);
}
