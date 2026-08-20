"use client";

import { Check, Copy, Image as ImageIcon, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { removeAsset } from "@/app/(panel)/assets/actions";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardActions, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { formatDate } from "@/lib/format/datetime";

/** An image as this component needs it, serialised for the client boundary. */
export interface AssetCardData {
	id: string;
	name: string;
	/** Pixels across and down, as uploaded. Not what is previewed — see {@link previewDots}. */
	width: number;
	height: number;
	mimeType: string;
	/** Where it was imported from, or null when it was uploaded. Provenance only. */
	sourceUrl: string | null;
	createdAt: string;
	/**
	 * The dithered raster as a PNG data URI, or null when it could not be rendered.
	 *
	 * Dithered on the server by the same code the printer's raster comes from, so what is on screen
	 * is what comes off the paper. Never re-derived here.
	 */
	preview: string | null;
	/** The paper width, in printer dots, the preview was dithered for. */
	previewDots: number;
}

/**
 * One stored image: what it will look like printed, and what to do with it.
 *
 * The preview is the reason this card is a card rather than a table row. An operator choosing
 * between two logos is choosing between two pictures, and the only picture worth showing is the
 * dithered one — the smooth original is a promise a thermal head cannot keep.
 */
export function AssetCard({ asset }: { asset: AssetCardData }) {
	const [pending, startTransition] = useTransition();
	const [copied, setCopied] = useState(false);

	/** What a receipt writes to print this image. The tag is paired; see the Docs tab. */
	const reference = `<image>${asset.name}</image>`;

	return (
		<Card className="flex flex-col">
			<CardHeader className="flex flex-row items-center gap-3 border-b border-border pb-3">
				<ImageIcon className="size-4.5 shrink-0 text-subtle-foreground" />
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-[13.5px] font-medium">{asset.name}</div>
					{/* `title` because an imported URL is routinely longer than the card is wide, and a
					    truncated one that cannot be read in full is provenance nobody can check. */}
					<div className="mt-0.5 truncate text-[11.5px] text-subtle-foreground" title={asset.sourceUrl ?? undefined}>
						{asset.sourceUrl ?? "Uploaded"}
					</div>
				</div>
				<Badge variant="outline" className="shrink-0 border-border bg-muted text-muted-foreground">
					{formatLabel(asset.mimeType)}
				</Badge>
			</CardHeader>

			<CardContent className="flex flex-1 flex-col gap-4 pt-4">
				{asset.preview ? (
					// White because this is paper, not panel: the dots that are not inked are the ones
					// the printer leaves blank, and showing them as the card's own dark surface would
					// invert the image an operator is being asked to judge.
					<div className="flex items-center justify-center overflow-hidden rounded-md border border-border bg-white p-2">
						{/** biome-ignore lint/performance/noImgElement: a data URI is already inlined; there is nothing for the image pipeline to optimise. */}
						<img
							src={asset.preview}
							alt={`${asset.name}, dithered as it will print`}
							// `pixelated` is load-bearing. The raster is one dot per pixel and the card is
							// narrower than the paper, so the browser scales it — and its default smoothing
							// blends a dither back into the greys the dither existed to get rid of, which
							// would show the operator a picture no printer can produce.
							className="max-h-64 w-full object-contain [image-rendering:pixelated]"
						/>
					</div>
				) : (
					<p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-subtle-foreground">
						This image could not be rendered. It is still stored, and still printable if the failure was temporary.
					</p>
				)}

				<dl className="grid grid-cols-2 gap-x-4 gap-y-3">
					<Detail label="Pixels" value={`${asset.width}×${asset.height}`} />
					{/* Stated because the preview is not the source: an operator comparing the speckle
					    against their paper needs to know which paper it was dithered for. */}
					<Detail label="Previewed at" value={`${asset.previewDots} dots`} />
					<Detail label="Added" value={formatDate(asset.createdAt)} />
				</dl>

				<CardActions className="gap-2">
					<Button
						variant="outline"
						size="sm"
						className="h-8"
						title={`Copy ${reference}`}
						disabled={pending}
						onClick={() => {
							void navigator.clipboard.writeText(reference);
							setCopied(true);
							toast.success("Markup reference copied.");
						}}
					>
						{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
						Copy reference
					</Button>

					<div className="flex-1" />

					<AlertDialog>
						<AlertDialogTrigger
							disabled={pending}
							render={
								<Button
									variant="outline"
									size="icon"
									className="size-8 border-destructive/40 text-destructive hover:bg-destructive/10"
									title="Delete"
									aria-label="Delete image"
								>
									{pending ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" />}
								</Button>
							}
						/>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Delete {asset.name}?</AlertDialogTitle>
								<AlertDialogDescription>
									Any receipt that says <span className="font-mono">{reference}</span> is refused until it is changed,
									or until an image of that name is stored again. This cannot be undone.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									className="bg-destructive text-white hover:bg-destructive/90"
									onClick={() =>
										startTransition(async () => {
											const result = await removeAsset(asset.id);
											if (result.error) {
												toast.error(result.error);
											} else {
												toast.success(`${asset.name} deleted.`);
											}
										})
									}
								>
									Delete
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</CardActions>
			</CardContent>
		</Card>
	);
}

/**
 * Names an image's format the way an operator would.
 *
 * The stored MIME type is the decoder's own answer rather than what the upload claimed, so it is
 * the honest thing to show — but `image/jpeg` in a badge is a header, not a word.
 *
 * @param mimeType what the decoder reported
 * @returns a short label
 */
function formatLabel(mimeType: string): string {
	switch (mimeType) {
		case "image/png":
			return "PNG";
		case "image/jpeg":
			return "JPEG";
		default:
			return mimeType;
	}
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<dt className="text-[11px] font-medium text-subtle-foreground">{label}</dt>
			<dd className="mt-0.5 truncate font-mono text-[12.5px]">{value}</dd>
		</div>
	);
}
