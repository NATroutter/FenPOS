"use client";

import { useState } from "react";
import { AvatarCropper, type CropperValue } from "@/components/panel/avatar-cropper";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/** A cropped square, rendered small enough to sit beside a form as a preview. */
const PREVIEW_PX = 128;

/**
 * Renders the chosen square to a data URL, so the caller can show what was picked.
 *
 * Canvas rather than CSS: the preview is a circle of an arbitrary square of an arbitrary picture,
 * and positioning a background to fake that is more fragile than drawing it once. `drawImage` reads
 * its source rectangle in the image's own pixels — the same coordinates the crop is expressed in and
 * the same ones the server will crop with — so what this draws is what gets stored, not an
 * approximation of it.
 *
 * @param image the decoded picture, as laid out by the browser
 * @param crop the chosen square in that picture's pixels
 * @returns a PNG data URL of the crop, or null when the canvas is unavailable
 */
function previewOf(image: HTMLImageElement, crop: CropperValue): string | null {
	const canvas = document.createElement("canvas");
	canvas.width = PREVIEW_PX;
	canvas.height = PREVIEW_PX;

	const context = canvas.getContext("2d");
	if (!context) {
		return null;
	}
	context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, PREVIEW_PX, PREVIEW_PX);
	return canvas.toDataURL("image/png");
}

/**
 * Choosing which square of a picked file becomes the avatar.
 *
 * **It saves nothing.** It hands the caller a crop and a preview and closes; storing them is the
 * caller's business, and on the profile dialog that does not happen until Save profile. Keeping the
 * decision here and the write there is what lets the picture be part of the form it sits in rather
 * than a separate thing that commits behind the form's back.
 *
 * Controlled, and rendered as a sibling of whatever opened it rather than a child — a dialog nested
 * inside another dialog's content unmounts the moment that dialog closes, and the two are never
 * meant to be on screen together anyway.
 */
export function AvatarCropDialog({
	open,
	onOpenChange,
	src,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Object URL of the picked file, or null when nothing is picked. */
	src: string | null;
	/** The chosen square, and a preview of it to show beside the form. */
	onConfirm: (crop: CropperValue, preview: string | null) => void;
}) {
	const [crop, setCrop] = useState<CropperValue | null>(null);
	const [image, setImage] = useState<HTMLImageElement | null>(null);

	const confirm = (): void => {
		if (!crop) {
			return;
		}
		onConfirm(crop, image ? previewOf(image, crop) : null);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[460px]">
				<DialogHeader>
					<DialogTitle>Crop your picture</DialogTitle>
					<DialogDescription>Drag or resize the circle over the part to keep.</DialogDescription>
				</DialogHeader>
				<DialogBody>{src ? <AvatarCropper src={src} onChange={setCrop} onImageReady={setImage} /> : null}</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={!crop} onClick={confirm}>
						Use this picture
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
