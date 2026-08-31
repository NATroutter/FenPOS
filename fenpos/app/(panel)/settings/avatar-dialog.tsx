"use client";

import { type ReactElement, type SyntheticEvent, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { AvatarCropper, type CropperValue, clampCrop } from "@/components/panel/avatar-cropper";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ActionState } from "@/lib/panel/action-state";

/**
 * Setting or removing one account's avatar: open on the current picture, pick a new one, drag or
 * zoom the crop, Save.
 *
 * **Shared between Settings and Users, parameterised by which action it submits to.** The signed-in
 * operator's own avatar (`setOwnAvatar`/`removeOwnAvatar`) and an administrator setting somebody
 * else's (`setUserAvatar`/`removeUserAvatar`, bound to a row's id) differ only in which server action
 * receives the finished `FormData` — everything else about picking a file, seeding the crop, and
 * reporting a refusal is identical, so this takes those as `onSave`/`onRemove` callbacks rather than
 * importing `setOwnAvatar` itself. The trigger is a `ReactElement`, the same convention every other
 * dialog in this panel uses (see `UploadDialog`, `ReplaceDialog`), so the caller decides what opens
 * it — the avatar itself on Settings, a row's own trigger on Users.
 *
 * **Real geometry lives in `clampCrop`, not here.** This component only tracks which file was picked,
 * the crop currently chosen over it, and whether a save is in flight; `clampCrop` and the letterboxing
 * inside `AvatarCropper` are what keep that crop inside the picture, and both are tested directly in
 * `test/components/panel/avatar-cropper.test.ts`. There is no test for this file: this repo runs
 * vitest in a Node environment with no DOM, so a dialog's own rendering and pointer handling cannot be
 * exercised here — the actions this submits to are what `test/app/(panel)/settings/avatar-actions.test.ts`
 * covers.
 */
export function AvatarDialog({
	trigger,
	onSave,
	onRemove,
}: {
	/** What opens the dialog. Cloned and given the dialog's own open/close handling, like every other panel dialog. */
	trigger: ReactElement;
	/** Submits the chosen file and crop. `setOwnAvatar` on Settings; `setUserAvatar` bound to a row's id on Users. */
	onSave: (formData: FormData) => Promise<ActionState>;
	/** Removes the current avatar, however it got there. */
	onRemove: () => Promise<ActionState>;
}) {
	const [open, setOpen] = useState(false);
	const [file, setFile] = useState<File | null>(null);
	const [objectUrl, setObjectUrl] = useState<string | null>(null);
	const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
	const [crop, setCrop] = useState<CropperValue>({ x: 0, y: 0, size: 1 });
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	// The one place this object URL is revoked: on every change (the cleanup for the *previous*
	// value runs before this effect re-fires for the next one) and on unmount, so a dialog opened
	// and closed — or a picture picked and then replaced with another — never leaves a blob URL
	// holding a whole picture's bytes in memory for the rest of the page's life.
	useEffect(() => {
		return () => {
			if (objectUrl) {
				URL.revokeObjectURL(objectUrl);
			}
		};
	}, [objectUrl]);

	const reset = (): void => {
		setFile(null);
		setObjectUrl(null);
		setNatural(null);
		setError(null);
	};

	const choose = (chosen: File | null): void => {
		setError(null);
		setNatural(null);
		setFile(chosen);
		setObjectUrl(chosen ? URL.createObjectURL(chosen) : null);
	};

	/**
	 * Seeds the crop with the largest centred square, once the picked file's own dimensions are
	 * known — they cannot be, until the browser has decoded it.
	 */
	const onImageLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
		const image = event.currentTarget;
		const size = { width: image.naturalWidth, height: image.naturalHeight };
		const shorterSide = Math.min(size.width, size.height);
		setNatural(size);
		setCrop(
			clampCrop({ x: (size.width - shorterSide) / 2, y: (size.height - shorterSide) / 2, size: shorterSide }, size),
		);
	};

	const save = (): void => {
		if (!file || !natural) {
			return;
		}
		setError(null);
		startTransition(async () => {
			const data = new FormData();
			data.set("file", file);
			data.set("x", String(crop.x));
			data.set("y", String(crop.y));
			data.set("size", String(crop.size));

			const result = await onSave(data);
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success("Avatar saved.");
			setOpen(false);
		});
	};

	const remove = (): void => {
		setError(null);
		startTransition(async () => {
			const result = await onRemove();
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success("Avatar removed.");
			setOpen(false);
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
			// After the animation completes, like `UploadDialog`/`ReplaceDialog`: clearing mid-close
			// would play the fade-out on a form that has already emptied itself.
			onOpenChangeComplete={(nowOpen) => {
				if (!nowOpen) {
					reset();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[420px]">
				<DialogHeader>
					<DialogTitle>Avatar</DialogTitle>
					<DialogDescription>Choose a picture, then drag or zoom the circle over the part to keep.</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{objectUrl && natural ? (
						<AvatarCropper src={objectUrl} natural={natural} value={crop} onChange={setCrop} disabled={pending} />
					) : objectUrl ? (
						// Invisible, and only here to decode the picked file's own dimensions: AvatarCropper
						// needs `natural` up front rather than discovering it itself, so this is what feeds it.
						// biome-ignore lint/performance/noImgElement: source is a local blob URL; only its natural size is read
						<img src={objectUrl} alt="" className="hidden" onLoad={onImageLoad} />
					) : null}

					<Field>
						<FieldLabel htmlFor="avatar-file">Picture</FieldLabel>
						<Input
							id="avatar-file"
							type="file"
							accept="image/png,image/jpeg"
							disabled={pending}
							onChange={(event) => choose(event.target.files?.[0] ?? null)}
						/>
						<FieldDescription>PNG or JPEG.</FieldDescription>
					</Field>

					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="destructive" disabled={pending} onClick={remove}>
						Remove
					</Button>
					<Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={pending || !file || !natural} onClick={save}>
						{pending ? <Spinner className="size-3.5" /> : null}
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
