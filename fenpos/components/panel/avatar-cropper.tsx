"use client";

import { useRef, useState } from "react";
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

/**
 * A square region of an uploaded picture, in its own pixels.
 *
 * Structurally identical to `CropRect` in `lib/auth/avatar-image.ts` and deliberately kept as its
 * own type rather than imported from there: that module starts with `import "server-only"`, and
 * this one is `"use client"`. Importing across that line would either poison this module into the
 * server layer or crash the bundler outright — the duplication here is what keeps the two sides of
 * the boundary a client component is actually allowed to see.
 */
export interface CropperValue {
	x: number;
	y: number;
	size: number;
}

/**
 * Bounds a crop to sit inside an image of the given size, in whole pixels.
 *
 * **This is the last thing between the interaction and the server.** `react-image-crop` decides what
 * the operator sees and drags; this decides what is allowed to leave. Keeping it as a plain function
 * of two objects is what lets it be tested without a DOM — see
 * `test/components/panel/avatar-cropper.test.ts` — and it stays even though the cropper is now a
 * library, because the server refuses fractional, oversized and out-of-bounds crops and something
 * has to guarantee it never sees one. A percentage converted back to pixels lands on fractions
 * routinely, so this is not a theoretical guard.
 *
 * `size` is rounded — and floored to a minimum of 1 — *before* it bounds anything else, and `x`/`y`
 * are rounded before they are clamped against it. That is the opposite of what an earlier version
 * of this function did (bound everything in real numbers, then round all three independently at the
 * end), which reads as the safer order but is not: a real-valued rectangle that fits exactly, such
 * as `size` bounding to `50.5` and `x` bounding to `49.5` in a 100-pixel-wide image, rounds *both*
 * of those values up independently — `x: 50, size: 51` — and 101 pixels no longer fits in 100. That
 * is not a hypothetical; the server's `requireValidCrop` refuses exactly this on a real drag (see
 * `lib/auth/avatar-image.ts`), which is what sends a legal crop back as an error. Rounding first
 * closes it: once `size` is a whole number, `width - size` and `height - size` are whole numbers
 * too, and clamping an already-whole `x`/`y` against a whole bound can only land inside it — there
 * is no independent rounding step left afterward to push the sum back out.
 *
 * The steps, in order:
 *
 * 1. `size` is rounded, then bounded to `[1, shorterSide]`. The floor of 1 exists because a `size`
 *    under 0.5 would otherwise round to 0, and the server refuses a crop with no size at all — the
 *    same document, same reason.
 * 2. `x` and `y` are rounded, then bounded to `[0, width - size]` and `[0, height - size]` — against
 *    this already-integer `size`, not the caller's raw one, for the same reason a wrong-ordered
 *    version of this function once bound them against an unshrunk `size` and produced a negative
 *    coordinate: bounding position against a square that is still too large pushes it past an edge
 *    instead of inside one.
 *
 * @param value the requested crop, in whatever units the interaction produced
 * @param natural the original image's decoded dimensions
 * @returns a crop that fits inside `natural`, in whole pixels, with `size` at least 1
 */
export function clampCrop(value: CropperValue, natural: { width: number; height: number }): CropperValue {
	const shorterSide = Math.min(natural.width, natural.height);
	const size = Math.min(Math.max(Math.round(value.size), 1), shorterSide);
	const x = Math.min(Math.max(Math.round(value.x), 0), natural.width - size);
	const y = Math.min(Math.max(Math.round(value.y), 0), natural.height - size);
	return { x, y, size };
}

/**
 * Turns the library's percentage crop into the whole natural pixels the server wants.
 *
 * The crop is held in `%` rather than pixels so it survives the image being laid out at a different
 * size — a dialog opening, a window resizing — without the selection jumping. The conversion back is
 * therefore against `naturalWidth`/`naturalHeight` and not against the element's rendered size.
 *
 * Only `width` is read for the side length. The selection is locked to `aspect={1}`, so it is square
 * in *rendered* pixels, and the render is uniformly scaled — but `width%` and `height%` are
 * percentages of two different dimensions, so on a non-square picture they are two different
 * numbers describing the same square. Taking one and letting {@link clampCrop} enforce squareness is
 * correct; averaging them or reading `height` for the height would not be.
 *
 * @param crop the library's current selection, in percent
 * @param natural the picture's decoded dimensions
 * @returns the crop in whole natural pixels, or null when there is no usable selection
 */
export function cropToNatural(crop: Crop | undefined, natural: { width: number; height: number }): CropperValue | null {
	if (!crop || crop.width === 0 || crop.height === 0) {
		return null;
	}
	if (crop.unit !== "%") {
		// The component below only ever holds a percentage crop. A pixel crop reaching here would be
		// silently wrong rather than obviously wrong, so it is refused instead of guessed at.
		return null;
	}
	return clampCrop(
		{
			x: (crop.x / 100) * natural.width,
			y: (crop.y / 100) * natural.height,
			size: (crop.width / 100) * natural.width,
		},
		natural,
	);
}

/**
 * Choosing the square of a picture that becomes an avatar.
 *
 * The interaction — drag, resize, keyboard, touch — is `react-image-crop`'s. This file owns three
 * things it does not: locking the selection square, seeding it to the largest centred square so the
 * common case needs no interaction at all, and converting what comes back into the whole natural
 * pixels the server will accept.
 *
 * **It was hand-rolled once and that was a mistake.** The original version tracked pointer events
 * over a circular mask itself and got two things wrong that no test in this repo could catch — the
 * drag scale on non-square images, and a mask that did not correspond to the region actually saved —
 * because this project runs vitest in a Node environment and a pointer gesture has no DOM to happen
 * in. A cropper is a deceptively large amount of interaction (touch, keyboard, edge handles, aspect
 * locking, resize) for something that is not this product's problem to solve.
 */
export function AvatarCropper({
	src,
	onChange,
	onImageReady,
	disabled,
}: {
	/** Object URL of the picked file. */
	src: string;
	/** The chosen square in natural pixels, or null while there is nothing usable yet. */
	onChange: (crop: CropperValue | null) => void;
	/**
	 * The decoded element, once the browser has it.
	 *
	 * Handed out so a caller can draw a preview of the crop from the same pixels the server will
	 * crop — see `AvatarCropDialog`. Nothing else about the element is the caller's to touch.
	 */
	onImageReady?: (image: HTMLImageElement) => void;
	disabled?: boolean;
}) {
	const [crop, setCrop] = useState<Crop | undefined>();
	const imageRef = useRef<HTMLImageElement | null>(null);

	const emit = (next: Crop | undefined): void => {
		const image = imageRef.current;
		if (!image) {
			onChange(null);
			return;
		}
		onChange(cropToNatural(next, { width: image.naturalWidth, height: image.naturalHeight }));
	};

	/**
	 * Seeds the largest centred square once the browser has decoded the picture, so an operator who
	 * is happy with the whole of it can press Save without touching anything.
	 */
	const onImageLoad = (event: React.SyntheticEvent<HTMLImageElement>): void => {
		const image = event.currentTarget;
		imageRef.current = image;
		onImageReady?.(image);

		const seeded = centerCrop(
			makeAspectCrop({ unit: "%", width: 100 }, 1, image.width, image.height),
			image.width,
			image.height,
		);
		setCrop(seeded);
		emit(seeded);
	};

	return (
		<div className="flex justify-center overflow-hidden rounded-md bg-muted/40 p-2">
			<ReactCrop
				crop={crop}
				onChange={(_pixel, percent) => {
					setCrop(percent);
					emit(percent);
				}}
				aspect={1}
				circularCrop
				keepSelection
				disabled={disabled}
				minWidth={16}
				className="max-h-[50vh]"
			>
				{/* biome-ignore lint/performance/noImgElement: a local blob URL, and the library measures this element directly */}
				<img src={src} alt="" onLoad={onImageLoad} className="max-h-[50vh] w-auto" />
			</ReactCrop>
		</div>
	);
}
