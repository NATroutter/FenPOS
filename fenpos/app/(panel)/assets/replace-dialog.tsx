"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { replaceAsset, replaceAssetFromUrl } from "@/app/(panel)/assets/actions";
import { ImageSourceTabs, useImageSource } from "@/app/(panel)/assets/image-source";
import type { AcceptedFormats } from "@/app/(panel)/assets/prose";
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
import type { AssetKind } from "@/lib/domain/enums";
import { describeBytes } from "@/lib/format/bytes";

/**
 * Swaps an asset's bytes, keeping its name — a redrawn logo's picture, or a font's own file.
 *
 * The counterpart of renaming, and the reason both exist as separate dialogs: one moves the
 * reference and leaves the file, the other moves the file and leaves the reference. Every receipt
 * naming it goes on printing it, with no edit anywhere, because the name they name is untouched.
 *
 * **The kind cannot change here**, and this dialog does not offer to try: `replaceAsset` refuses a
 * font submitted for an image's name or the reverse, so the only question this asks is where the new
 * bytes come from. `kind` is carried through only to say what those bytes must be.
 *
 * Same two sources as adding, through the same component. An operator replacing an asset should not
 * have fewer ways to supply one than an operator adding it, and should not have to learn a second
 * layout to use them.
 */

/**
 * Names the accepted image formats alone, for a replacement that can only ever be an image —
 * `acceptedFormatsPhrase` (`prose.ts`) always mentions fonts too, which is right for the Add dialog's
 * either-kind File tab and wrong here: a font offered where only an image can land would just be
 * refused, and saying "or a font" first would read as an invitation this dialog cannot honour.
 */
const IMAGE_FORMATS_PHRASE: Record<AcceptedFormats, string> = { "png+jpeg": "PNG or JPEG", png: "PNG" };

export function ReplaceDialog({
	assetId,
	assetName,
	kind,
	maxBytes,
	acceptedFormats,
	trigger,
}: {
	assetId: string;
	assetName: string;
	/** What is being replaced. Fixed — the service refuses a replacement that changes it. */
	kind: AssetKind;
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
						{kind === "FONT"
							? `A TTF or OTF font, up to ${describeBytes(maxBytes)}. The name stays as it is, so every receipt that already draws this font draws the new one without being edited.`
							: `${IMAGE_FORMATS_PHRASE[acceptedFormats]} images, up to ${describeBytes(maxBytes)}. The name stays as it is, so every receipt that already prints this image prints the new one without being edited.`}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<ImageSourceTabs
							source={source}
							acceptedFormats={acceptedFormats}
							disabled={saving}
							idPrefix={`asset-replace-${assetId}`}
							// A font has no URL source at all — `replaceAssetFromUrl` only ever fetches an
							// image, and the service would refuse the result for changing the asset's kind.
							// Offering a tab that always fails is worse than not offering it.
							allow={{ file: true, url: kind !== "FONT" }}
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
						{kind === "FONT" ? "Replace font" : "Replace image"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
