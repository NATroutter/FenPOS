"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { replaceAsset, replaceAssetFromUrl } from "@/app/(panel)/assets/actions";
import { ImageSourceTabs, useImageSource } from "@/app/(panel)/assets/image-source";
import { type AcceptedFormats, acceptedFormatsPhrase } from "@/app/(panel)/assets/prose";
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
import { Spinner } from "@/components/ui/spinner";
import { describeBytes } from "@/lib/format/bytes";

/**
 * Swaps an image's picture, keeping its name.
 *
 * The counterpart of renaming, and the reason both exist as separate dialogs: one moves the
 * reference and leaves the picture, the other moves the picture and leaves the reference. A redrawn
 * logo wants this one — every receipt printing it goes on printing it, with no edit anywhere,
 * because the name they name is untouched.
 *
 * Same two sources as adding, through the same component. An operator replacing an image should not
 * have fewer ways to supply one than an operator adding it, and should not have to learn a second
 * layout to use them.
 */
export function ReplaceDialog({
	assetId,
	assetName,
	maxBytes,
	acceptedFormats,
	trigger,
}: {
	assetId: string;
	assetName: string;
	maxBytes: number;
	/** The configured `assets.acceptedFormats`, read server-side and passed down as a plain prop. */
	acceptedFormats: AcceptedFormats;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [saving, startSave] = useTransition();
	const source = useImageSource(maxBytes);

	const submit = (): void => {
		source.setError(null);

		startSave(async () => {
			let result: { error: string | null };
			if (source.tab === "file" && source.file) {
				const form = new FormData();
				form.set("id", assetId);
				form.set("file", source.file);
				result = await replaceAsset(form);
			} else {
				result = await replaceAssetFromUrl(assetId, source.trimmedUrl);
			}

			if (result.error) {
				source.setError(result.error);
				return;
			}
			toast.success(`${assetName} replaced.`);
			setOpen(false);
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					source.reset();
				}
			}}
			onOpenChangeComplete={(nowOpen) => {
				if (!nowOpen) {
					source.reset();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>Replace {assetName}</DialogTitle>
					<DialogDescription>
						{acceptedFormatsPhrase(acceptedFormats)}, up to {describeBytes(maxBytes)}. The name stays as it is, so every
						receipt that already prints this image prints the new one without being edited.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<ImageSourceTabs
							source={source}
							acceptedFormats={acceptedFormats}
							disabled={saving}
							idPrefix={`asset-replace-${assetId}`}
						/>

						{source.error ? (
							<Alert variant="destructive">
								<AlertDescription>{source.error}</AlertDescription>
							</Alert>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={saving || !source.ready} onClick={submit}>
						{saving ? <Spinner className="size-3.5" /> : null}
						Replace image
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
