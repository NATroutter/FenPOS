"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { importAsset, uploadAsset } from "@/app/(panel)/assets/actions";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toNameCandidate } from "@/lib/domain/naming";
import { describeBytes } from "@/lib/format/bytes";

/**
 * Adds an image, from a file or from a URL.
 *
 * **One dialog rather than two.** The choice between uploading a file and fetching a URL is a
 * detail of where the bytes come from; everything else — the name markup will use, the limits, the
 * refusals — is identical, and splitting it in two would put the same form on screen twice and
 * invite them to drift. The two sources are tabs, so the exclusivity is stated before the fact
 * rather than discovered when one field greys out the other — see `image-source.tsx`.
 *
 * A URL is fetched **once, now**, and the bytes are stored. `sourceUrl` is kept as provenance and
 * never fetched again, which is worth saying in the dialog: an operator who expects the logo to
 * follow changes at the far end would otherwise find out much later.
 */
export function UploadDialog({
	maxBytes,
	acceptedFormats,
	trigger,
}: {
	maxBytes: number;
	/** The configured `assets.acceptedFormats`, read server-side — `settings-service.ts` is
	 *  server-only, so this has to arrive as a plain, serialisable prop rather than be read here. */
	acceptedFormats: AcceptedFormats;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [saving, startSave] = useTransition();
	const source = useImageSource(maxBytes);

	const ready = name.trim() !== "" && source.ready;

	const add = (): void => {
		source.setError(null);
		const finalName = toNameCandidate(name);

		startSave(async () => {
			let result: { error: string | null };
			if (source.tab === "file" && source.file) {
				const form = new FormData();
				form.set("name", finalName);
				form.set("file", source.file);
				result = await uploadAsset(form);
			} else {
				result = await importAsset(finalName, source.trimmedUrl);
			}

			if (result.error) {
				source.setError(result.error);
				return;
			}
			toast.success(`${finalName} added.`);
			setOpen(false);
		});
	};

	/** Returns the dialog to its opening state. Safe to call more than once. */
	const reset = (): void => {
		setName("");
		source.reset();
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// Also on the way in, because reopening inside the closing animation's 100ms never
				// reaches the handler below, and the dialog would come back holding the last attempt.
				if (next) {
					reset();
				}
			}}
			// After the animation rather than at the click. Clearing during the close plays the
			// fade-out on a form that has already emptied itself, which is what made the API-key
			// dialog flash the wrong pane on its way out.
			onOpenChangeComplete={(nowOpen) => {
				if (!nowOpen) {
					reset();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>Add an image</DialogTitle>
					<DialogDescription>
						{acceptedFormatsPhrase(acceptedFormats)}, up to {describeBytes(maxBytes)}. It is stored as uploaded and
						dithered for each printer's own paper width, so the same image suits 58mm and 80mm alike.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="asset-name">Name</FieldLabel>
							<Input
								id="asset-name"
								value={name}
								disabled={saving}
								placeholder="logo"
								onChange={(event) => setName(toNameCandidate(event.target.value, { keepTrailingSeparator: true }))}
							/>
							<FieldDescription>
								What markup refers to it by: <span className="font-mono">&lt;image&gt;logo&lt;/image&gt;</span>. A slug,
								for the same reason printer names are.
							</FieldDescription>
						</Field>

						<ImageSourceTabs source={source} acceptedFormats={acceptedFormats} disabled={saving} idPrefix="asset-add" />

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
					<Button type="button" disabled={saving || !ready} onClick={add}>
						{saving ? <Spinner className="size-3.5" /> : null}
						Add image
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
