"use client";

import { Check, Copy, Image as ImageIcon, Pencil, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { removeAsset } from "@/app/(panel)/assets/actions";
import { PreviewDialog } from "@/app/(panel)/assets/preview-dialog";
import type { AcceptedFormats } from "@/app/(panel)/assets/prose";
import { RenameDialog } from "@/app/(panel)/assets/rename-dialog";
import { ReplaceDialog } from "@/app/(panel)/assets/replace-dialog";
import type { AssetPermits } from "@/app/(panel)/tab-permits";
import { DitheredImage } from "@/components/panel/dithered-image";
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

/** How long the copied tick stays up. Long enough to be seen, short enough to stop meaning "just now". */
const COPIED_TICK_MS = 2000;

/**
 * One stored image: what it will look like printed, and what to do with it.
 *
 * The preview is the reason this card is a card rather than a table row. An operator choosing
 * between two logos is choosing between two pictures, and the only picture worth showing is the
 * dithered one — the smooth original is a promise a thermal head cannot keep.
 */
export function AssetCard({
	asset,
	maxBytes,
	acceptedFormats,
	permits,
}: {
	asset: AssetCardData;
	/** The configured upload cap, needed by the replace dialog this card owns. */
	maxBytes: number;
	/** The configured `assets.acceptedFormats`, read server-side and passed down as a plain prop. */
	acceptedFormats: AcceptedFormats;
	permits: AssetPermits;
}) {
	const [pending, startTransition] = useTransition();
	const [copied, setCopied] = useState(false);

	/**
	 * The tick, which has to go away again.
	 *
	 * It confirms one press, so it is timed rather than sticky: the panel is a tab left open all day,
	 * and a tick that never resets stops meaning "copied just now" within a minute of meaning it. The
	 * timer is cleared on unmount and on a second press, so a card deleted mid-tick sets no state on a
	 * component that is gone.
	 */
	const resetAt = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => clearTimeout(resetAt.current ?? undefined), []);

	const confirmCopied = (): void => {
		setCopied(true);
		clearTimeout(resetAt.current ?? undefined);
		resetAt.current = setTimeout(() => setCopied(false), COPIED_TICK_MS);
	};

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
					<PreviewDialog
						name={asset.name}
						preview={asset.preview}
						previewDots={asset.previewDots}
						trigger={
							// A button rather than a div with a click handler, so the preview is reachable by
							// keyboard and announced as something that does something. White because this is
							// paper, not panel: the dots that are not inked are the ones the printer leaves
							// blank, and showing them as the card's own dark surface would invert the image an
							// operator is being asked to judge. Same surface the Tools tab's sheet is drawn on —
							// a hairline ring rather than a border, because a dark border around white paper
							// reads as a frame around the picture instead.
							<button
								type="button"
								title={`Show ${asset.name} at full size`}
								aria-label={`Show ${asset.name} at full size`}
								className="flex cursor-zoom-in items-center justify-center overflow-hidden rounded-sm bg-white p-2 shadow-sm ring-1 ring-black/10 transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							>
								{/* The resampling is chosen from the drawn size rather than fixed, because neither
							    answer is right at both. This card is usually narrower than the paper, where
							    averaging the dots is what shows the tone the paper shows — but a small stored
							    image is stretched up to the card instead, and there the dots are the subject.
							    See `ditherFilterFor`. */}
								<DitheredImage
									src={asset.preview}
									alt={`${asset.name}, dithered as it will print`}
									className="max-h-64 w-full object-contain"
								/>
							</button>
						}
					/>
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
							confirmCopied();
							toast.success("Markup reference copied.");
						}}
					>
						{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
						Copy reference
					</Button>

					<div className="flex-1" />

					{/* Ordered by how much they change and how recoverable they are: rename moves the
					    reference, replace moves the picture, delete takes both away. The destructive one
					    is last and set apart by colour, so the two ordinary edits are not sitting next to
					    it looking equally final. Each is its own permission, so the row thins out rather
					    than disappearing — Copy reference is always there, and it is the one thing an
					    operator holding `assets:read` alone actually came for. */}
					{!permits["assets:rename"] ? null : (
						<RenameDialog
							assetId={asset.id}
							assetName={asset.name}
							trigger={
								<Button
									variant="outline"
									size="icon"
									className="size-8"
									title="Rename"
									aria-label={`Rename ${asset.name}`}
									disabled={pending}
								>
									<Pencil className="size-3.5" />
								</Button>
							}
						/>
					)}

					{!permits["assets:replace"] ? null : (
						<ReplaceDialog
							assetId={asset.id}
							assetName={asset.name}
							maxBytes={maxBytes}
							acceptedFormats={acceptedFormats}
							trigger={
								<Button
									variant="outline"
									size="icon"
									className="size-8"
									title="Replace the image"
									aria-label={`Replace the image for ${asset.name}`}
									disabled={pending}
								>
									<Upload className="size-3.5" />
								</Button>
							}
						/>
					)}

					{!permits["assets:delete"] ? null : (
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
					)}
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
