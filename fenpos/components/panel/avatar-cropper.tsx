"use client";

import { type PointerEvent as ReactPointerEvent, useRef } from "react";
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

/** How many image pixels one screen pixel of dragging moves the crop, at the current zoom. */
function scaleFactor(imageBox: HTMLDivElement, natural: { width: number; height: number }): number {
	const rect = imageBox.getBoundingClientRect();
	// The box is always square (an `aspect-square` wrapper below), so either side gives the same
	// answer; `width` is picked arbitrarily.
	return rect.width === 0 ? 1 : natural.width / rect.width;
}

/**
 * A drag-and-zoom cropper: one square, dragged and resized over a circular mask.
 *
 * Hand-rolled on pointer events rather than a cropper dependency — there is exactly one shape
 * (a square, for a round avatar) and one gesture (drag to move, a slider to zoom), which is little
 * enough surface that a dependency would cost more to configure than it saves.
 *
 * The mask is drawn, not cut: a dimmed surround sits over the whole image and a `rounded-full` ring
 * the size of the current crop sits on top of it, so what shows through the ring is exactly the
 * square `value` describes. Nothing about the mask feeds back into the geometry — it is a picture
 * of `value`, not a second source of truth for it.
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
		const scale = scaleFactor(box, natural);
		// Dragging the image right moves the *visible window* left, hence the negated delta: the
		// crop's `x`/`y` describe where the square sits on the original picture, not where the
		// picture sits under the square.
		const next: CropperValue = {
			x: drag.origin.x - (event.clientX - drag.startX) * scale,
			y: drag.origin.y - (event.clientY - drag.startY) * scale,
			size: drag.origin.size,
		};
		onChange(clampCrop(next, natural));
	};

	const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (dragRef.current?.pointerId === event.pointerId) {
			dragRef.current = null;
		}
	};

	const handleZoom = (event: React.ChangeEvent<HTMLInputElement>): void => {
		const nextSize = Number(event.target.value);
		// Zooming keeps the square centred on itself rather than anchored at its top-left corner —
		// the corner a smaller `size` would otherwise leave the crop drifting away from.
		const centerX = value.x + value.size / 2;
		const centerY = value.y + value.size / 2;
		onChange(clampCrop({ x: centerX - nextSize / 2, y: centerY - nextSize / 2, size: nextSize }, natural));
	};

	const shorterSide = Math.min(natural.width, natural.height);

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
					className="pointer-events-none absolute inset-0 size-full object-cover"
					draggable={false}
				/>

				{/* The dimmed surround. A single element rather than four bars around the ring: an SVG
				    mask would need to react to every drag, where a solid layer plus a transparent ring
				    punched through it by `box-shadow` needs no measurement of the ring's position at all. */}
				<div
					aria-hidden
					className="pointer-events-none absolute rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
					style={{
						left: `${(value.x / natural.width) * 100}%`,
						top: `${(value.y / natural.height) * 100}%`,
						width: `${(value.size / natural.width) * 100}%`,
						height: `${(value.size / natural.height) * 100}%`,
					}}
				/>
			</div>

			<input
				type="range"
				min={Math.min(64, shorterSide)}
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
