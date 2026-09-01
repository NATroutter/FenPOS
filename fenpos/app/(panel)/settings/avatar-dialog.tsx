"use client";

import { Camera, ImageOff } from "lucide-react";
import { cloneElement, type ReactElement, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { AvatarCropDialog } from "@/components/panel/avatar-crop-dialog";
import type { CropperValue } from "@/components/panel/avatar-cropper";
import type { ActionState } from "@/lib/panel/action-state";

/**
 * Setting or removing one account's avatar from a table row, where there is no form to save into.
 *
 * **This writes immediately, and the profile dialog deliberately does not.** On Settings the picture
 * is one field of a form and is committed by Save profile alongside the name and the email; a row
 * has no such button, so confirming a crop here is the commit. What the two share is
 * {@link AvatarCropDialog} — the choosing and the cropping — not the saving, which is the half they
 * genuinely disagree about.
 *
 * The buttons open the file picker directly rather than a dialog containing a file input. There is
 * nothing to decide before a picture is chosen, so a dialog in front of the picker was only ever an
 * extra step; the crop dialog appears once there is something to crop.
 *
 * @param renderButton draws one action button the way the surrounding row draws its others
 */
export function AvatarDialog({
	renderButton,
	hasAvatar,
	onSave,
	onRemove,
}: {
	renderButton: (props: { title: string; icon: ReactElement; onClick: () => void; disabled: boolean }) => ReactElement;
	/** Whether the account currently has a picture, which decides whether removing is offered. */
	hasAvatar: boolean;
	/** Submits the chosen file and crop — `setUserAvatar` bound to this row's id. */
	onSave: (formData: FormData) => Promise<ActionState>;
	/** Removes the current avatar — `removeUserAvatar` bound to this row's id. */
	onRemove: () => Promise<ActionState>;
}) {
	const [cropOpen, setCropOpen] = useState(false);
	const [pickedFile, setPickedFile] = useState<File | null>(null);
	const [pickedUrl, setPickedUrl] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Released on every replacement and on unmount, so a picture chosen and then replaced never leaves
	// a blob URL holding its bytes for the life of the page.
	useEffect(() => {
		return () => {
			if (pickedUrl) {
				URL.revokeObjectURL(pickedUrl);
			}
		};
	}, [pickedUrl]);

	const clearChoice = (): void => {
		setPickedFile(null);
		setPickedUrl(null);
		// An unchanged value fires no `change` event, so without this the same file cannot be picked
		// twice in a row.
		if (inputRef.current) {
			inputRef.current.value = "";
		}
	};

	const choose = (chosen: File | null): void => {
		if (!chosen) {
			return;
		}
		setPickedFile(chosen);
		setPickedUrl(URL.createObjectURL(chosen));
		setCropOpen(true);
	};

	const save = (crop: CropperValue): void => {
		if (!pickedFile) {
			return;
		}
		const file = pickedFile;
		startTransition(async () => {
			const data = new FormData();
			data.set("file", file);
			data.set("x", String(crop.x));
			data.set("y", String(crop.y));
			data.set("size", String(crop.size));

			const result = await onSave(data);
			clearChoice();
			if (result.error) {
				toast.error(result.error);
				return;
			}
			toast.success("Avatar saved.");
		});
	};

	const remove = (): void => {
		startTransition(async () => {
			const result = await onRemove();
			if (result.error) {
				toast.error(result.error);
				return;
			}
			toast.success("Avatar removed.");
		});
	};

	return (
		<>
			{cloneElement(
				renderButton({
					title: hasAvatar ? "Change avatar" : "Set avatar",
					icon: <Camera className="size-3.5" />,
					onClick: () => inputRef.current?.click(),
					disabled: pending,
				}),
				{ key: "set" },
			)}
			{hasAvatar
				? cloneElement(
						renderButton({
							title: "Remove avatar",
							icon: <ImageOff className="size-3.5" />,
							onClick: remove,
							disabled: pending,
						}),
						{ key: "remove" },
					)
				: null}
			<input
				ref={inputRef}
				type="file"
				accept="image/png,image/jpeg"
				className="hidden"
				disabled={pending}
				onChange={(event) => choose(event.target.files?.[0] ?? null)}
			/>
			<AvatarCropDialog
				open={cropOpen}
				onOpenChange={(nextOpen) => {
					setCropOpen(nextOpen);
					if (!nextOpen) {
						clearChoice();
					}
				}}
				src={pickedUrl}
				onConfirm={(crop) => save(crop)}
			/>
		</>
	);
}
