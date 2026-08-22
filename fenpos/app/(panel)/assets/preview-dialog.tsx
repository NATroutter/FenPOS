"use client";

import type { ReactElement } from "react";
import { DitheredImage } from "@/components/panel/dithered-image";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

/**
 * One image's dithered preview, filling the window.
 *
 * The card scales its preview to whatever width the grid gives it, which is right there — an operator
 * choosing between two logos is comparing pictures. It is wrong for judging the dither itself, where
 * speckle averaged down to card width just reads as grey, and the question an operator actually has
 * is whether the logo survives being reduced to one ink. That question is answered by making it big.
 *
 * The raster is drawn as large as the window allows rather than at a fixed multiple of its dots.
 * A whole-number multiple would keep every dot an exact square, but it also fixes the size: at 2× a
 * 384-dot logo is 768 pixels whatever the screen, which is a small picture on the monitor most of
 * these panels are open on. Filling the viewport is the more useful answer, and `pixelated` keeps the
 * dots hard-edged on the way up — a dot may land a fraction of a pixel wider than its neighbour, but
 * nothing is blurred and nothing is invented.
 *
 * **Height is the only dimension this sets.** The width follows from the raster's own proportions, so
 * the white surface ends where the picture does. Sizing both would stretch the paper to the window
 * and leave a narrow logo floating in a wide blank field — which looks like margin the printer is
 * going to feed, and is not.
 *
 * Nothing is re-derived here. The same data URI the card already holds is drawn larger, so opening
 * this costs a repaint and no server work at all.
 */
export function PreviewDialog({
	name,
	preview,
	previewDots,
	trigger,
}: {
	name: string;
	/** The dithered raster as a PNG data URI, exactly as the card received it. */
	preview: string;
	/** The paper width, in printer dots, this was dithered for. */
	previewDots: number;
	trigger: ReactElement;
}) {
	return (
		<Dialog>
			<DialogTrigger render={trigger} />
			{/* **Height is the only dimension given.** The picture grows to fill 90% of the window
			    vertically and the width follows from its own proportions, so a square logo stays square
			    and a tall one stays tall. Fixing the width too would size the paper to the window rather
			    than to the receipt, and a narrow logo would sit in a wide blank field that reads as part
			    of what gets printed.

			    `w-fit` with `!max-w-[95vw]` to override the dialog's own `sm:max-w-lg` default: the
			    dialog is as wide as its content, and the cap only matters for a raster wide enough to
			    reach the edge of the window. */}
			<DialogContent className="flex w-fit !max-w-[95vw] flex-col">
				<DialogHeader>
					<DialogTitle className="font-mono">{name}</DialogTitle>
					<DialogDescription>
						{previewDots} dots across — every dot here is ink the printer puts down.
					</DialogDescription>
				</DialogHeader>
				{/* White because this is paper, not panel, for the same reason the card's frame is: the
				    dots that are not inked are the ones the printer leaves blank.

				    `min-h-0` so this flex child may actually shrink to the space left under the header —
				    without it a tall raster pushes the box past the dialog's own height and the bottom
				    of the image is simply cut off. */}
				<div className="mx-auto w-fit max-w-full overflow-hidden rounded-sm bg-white p-3 shadow-sm ring-1 ring-black/10">
					{/* **The height is a viewport length, not `h-full`, and that is not a style choice.**
					    This box is `w-fit`, so its width comes from the image; with `h-full` the image's
					    height would come from the box, and its width from that height — a cycle the
					    browser breaks by falling back to the raster's intrinsic size, which is how this
					    ended up a small picture in a tall white field. Naming the height outright leaves
					    the width the only thing to derive.

					    `90vh` less the header and this box's padding, so the dialog as a whole comes to
					    about nine tenths of the window. `max-w-full` is the one concession, for a raster
					    wide enough that its full height would push it past the window's edge.

					    `DitheredImage` measures the drawn size and settles on `pixelated` for anything at
					    or above 1:1, so the dots stay hard squares on the way up rather than smearing
					    into grey. */}
					<DitheredImage
						src={preview}
						alt={`${name}, dithered as it will print`}
						className="max-w-full object-contain"
						style={{ height: "calc(90vh - 8rem)", width: "auto" }}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
