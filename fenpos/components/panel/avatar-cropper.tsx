"use client";

import { type ChangeEvent, type PointerEvent as ReactPointerEvent, useRef } from "react";
import { cn } from "@/lib/utils";

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
 * Every geometry decision the cropper makes lives here rather than in the component below, so it
 * can be tested as a plain function of two objects — see `test/components/panel/avatar-cropper.test.ts`.
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
 * @param value the requested crop, in whatever units a drag or a zoom slider produced
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

/** Where, and at what scale, a `natural`-sized image is drawn inside `box` under `object-fit: contain`. */
export interface ContainedRect {
	/** Horizontal letterbox: how far the drawn image sits from the box's left edge, in box units. */
	offsetX: number;
	/** Vertical letterbox: how far the drawn image sits from the box's top edge, in box units. */
	offsetY: number;
	/** Box units per natural pixel — how large the image is actually drawn, not its natural size. */
	scale: number;
}

/**
 * Works out the letterboxing `object-fit: contain` produces, so the pointer math and the mask can
 * agree on where the image actually is instead of each assuming it fills its box.
 *
 * `contain` scales the image by `min(box.width/natural.width, box.height/natural.height)` — the
 * *smaller* of the two ratios, so the longer natural side is the one that ends up flush with the
 * box, and the other is centred inside it with bars on either side. `object-fit: cover` — what this
 * component used before — scales by the *larger* ratio instead, filling the box completely and
 * cropping whatever doesn't fit; for a non-square image in a square box, that hides a third of a
 * landscape photo (or a portrait one) that a square crop can never be dragged onto, while
 * {@link clampCrop} happily allows a crop there. `contain` is what makes the crop this function
 * bounds — "any square inside the whole picture" — the same set of squares the interface can
 * actually show and reach.
 *
 * `box` need not be real pixels: because `offsetX`, `offsetY`, and `scale` are all linear in `box`'s
 * dimensions for a fixed aspect ratio, passing a unit box (`{ width: 1, height: 1 }`) returns them
 * as *fractions* of whatever box they end up drawn in — which is what lets {@link cropToBoxRect}
 * answer in CSS percentages without ever measuring the DOM.
 *
 * @param natural the image's own decoded dimensions
 * @param box the space it is being fit into — real pixels for pointer math, a unit box for CSS percentages
 */
export function containedRect(
	natural: { width: number; height: number },
	box: { width: number; height: number },
): ContainedRect {
	if (natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) {
		return { offsetX: 0, offsetY: 0, scale: 1 };
	}
	const scale = Math.min(box.width / natural.width, box.height / natural.height);
	return {
		offsetX: (box.width - natural.width * scale) / 2,
		offsetY: (box.height - natural.height * scale) / 2,
		scale,
	};
}

/**
 * Where a crop, given in natural pixels, lands inside `box` once {@link containedRect} has placed
 * the image in it — the rectangle the mask is drawn at.
 *
 * Built from {@link containedRect} rather than repeating its arithmetic, so the mask and the pointer
 * conversion in `AvatarCropper` cannot drift apart: both go through the exact same letterboxing.
 *
 * @returns the crop's rectangle in `box`'s own units (see {@link containedRect}'s `box` note)
 */
export function cropToBoxRect(
	value: CropperValue,
	natural: { width: number; height: number },
	box: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
	const { offsetX, offsetY, scale } = containedRect(natural, box);
	return {
		left: offsetX + value.x * scale,
		top: offsetY + value.y * scale,
		width: value.size * scale,
		height: value.size * scale,
	};
}

/**
 * A drag-and-zoom cropper: one square, dragged and resized over a circular mask.
 *
 * Hand-rolled on pointer events rather than a cropper dependency — there is exactly one shape
 * (a square, for a round avatar) and one gesture (drag to move, a slider to zoom), which is little
 * enough surface that a dependency would cost more to configure than it saves.
 *
 * The image is shown with `object-contain`, not `object-cover` — see {@link containedRect}'s doc
 * comment for why cover was the wrong fit here. The mask is drawn, not cut: a dimmed surround sits
 * over the whole box and a `rounded-full` ring at {@link cropToBoxRect}'s rectangle sits on top of
 * it, so what shows through the ring is exactly the square `value` describes. Nothing about the mask
 * feeds back into the geometry — it is a picture of `value`, not a second source of truth for it.
 *
 * Every path that changes `value` — a drag, or the zoom slider — computes the next rectangle and
 * passes it through {@link clampCrop} before calling `onChange`, so this component cannot hand the
 * caller a rectangle the image does not actually contain.
 */
export function AvatarCropper({
	src,
	natural,
	value,
	onChange,
	disabled,
}: {
	/** The image being cropped, as a URL the browser can load directly (a blob URL for a fresh pick). */
	src: string;
	/** The image's own decoded dimensions, in pixels — what `clampCrop` bounds against. */
	natural: { width: number; height: number };
	/** The current crop, already inside `natural` — the caller is expected to have clamped it. */
	value: CropperValue;
	/** Called with the next crop, already clamped, on every drag move and zoom change. */
	onChange: (next: CropperValue) => void;
	/** Freezes dragging and the zoom slider, while a save is in flight. */
	disabled?: boolean;
}) {
	const boxRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: CropperValue } | null>(null);

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (disabled) {
			return;
		}
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: value };
	};

	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const drag = dragRef.current;
		const box = boxRef.current;
		if (!drag || !box || drag.pointerId !== event.pointerId) {
			return;
		}
		const rect = box.getBoundingClientRect();
		const { scale } = containedRect(natural, { width: rect.width, height: rect.height });
		// `scale` is box pixels per natural pixel — how large `object-contain` is actually drawing
		// the image, not the box's own size — so dividing a screen-pixel delta by it, rather than by
		// the box's width, is what makes one screen pixel of dragging move the crop by the natural
		// pixel that pixel actually covers on screen, whichever side is letterboxed.
		//
		// Dragging the image right moves the *visible window* left, hence the negated delta: the
		// crop's `x`/`y` describe where the square sits on the original picture, not where the
		// picture sits under the square.
		const next: CropperValue = {
			x: drag.origin.x - (event.clientX - drag.startX) / scale,
			y: drag.origin.y - (event.clientY - drag.startY) / scale,
			size: drag.origin.size,
		};
		onChange(clampCrop(next, natural));
	};

	const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (dragRef.current?.pointerId === event.pointerId) {
			dragRef.current = null;
		}
	};

	const handleZoom = (event: ChangeEvent<HTMLInputElement>): void => {
		const nextSize = Number(event.target.value);
		// Zooming keeps the square centred on itself rather than anchored at its top-left corner —
		// the corner a smaller `size` would otherwise leave the crop drifting away from.
		const centerX = value.x + value.size / 2;
		const centerY = value.y + value.size / 2;
		onChange(clampCrop({ x: centerX - nextSize / 2, y: centerY - nextSize / 2, size: nextSize }, natural));
	};

	const shorterSide = Math.min(natural.width, natural.height);
	// Derived from `shorterSide` rather than a second `Math.min(natural.width, natural.height)` at
	// the range input below, so there is exactly one place in this component that reads the image's
	// own dimensions to decide how far the slider can zoom.
	const zoomMin = Math.min(64, shorterSide);
	// A unit box: `containedRect` (and this) return offsets and a scale that are fractions of
	// whatever box they're given for a fixed aspect ratio, so this needs no measurement of the box's
	// actual rendered size — the same reason the CSS below can express it as plain percentages.
	const maskRect = cropToBoxRect(value, natural, { width: 1, height: 1 });

	return (
		<div className="flex flex-col gap-3">
			<div
				ref={boxRef}
				className={cn(
					"relative aspect-square w-full touch-none overflow-hidden rounded-md bg-muted select-none",
					disabled && "pointer-events-none opacity-60",
				)}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
			>
				{/* A plain <img>, not next/image: the source is very often a blob URL for a picture the
				    user just picked and has not uploaded anywhere yet, which the optimiser cannot fetch. */}
				{/* biome-ignore lint/performance/noImgElement: source may be a local blob URL */}
				<img
					src={src}
					alt=""
					className="pointer-events-none absolute inset-0 size-full object-contain"
					draggable={false}
				/>

				{/* The dimmed surround. A single element rather than four bars around the ring: an SVG
				    mask would need to react to every drag, where a solid layer plus a transparent ring
				    punched through it by `box-shadow` needs no measurement of the ring's position at all. */}
				<div
					aria-hidden
					className="pointer-events-none absolute rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
					style={{
						left: `${maskRect.left * 100}%`,
						top: `${maskRect.top * 100}%`,
						width: `${maskRect.width * 100}%`,
						height: `${maskRect.height * 100}%`,
					}}
				/>
			</div>

			<input
				type="range"
				min={zoomMin}
				max={shorterSide}
				value={value.size}
				disabled={disabled}
				onChange={handleZoom}
				className="w-full accent-primary"
				aria-label="Zoom"
			/>
		</div>
	);
}
