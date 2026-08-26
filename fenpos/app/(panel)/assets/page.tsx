import { Image as ImageIcon, Plus } from "lucide-react";
import { AssetCard, type AssetCardData } from "@/app/(panel)/assets/asset-card";
import type { AcceptedFormats } from "@/app/(panel)/assets/prose";
import { UploadDialog } from "@/app/(panel)/assets/upload-dialog";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { listAssets, maxAssetBytes, rasterFor } from "@/lib/assets/asset-service";
import { rasterToPngDataUrl } from "@/lib/assets/preview";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { logger } from "@/lib/logger";
import { dotWidth } from "@/lib/markup/blocks";
import { enumSetting } from "@/lib/settings/settings-service";

export const metadata = { title: "Assets" };

/** Never cached: the library changes as images are added and deleted, and previews are derived here. */
export const dynamic = "force-dynamic";

/**
 * The paper width the previews are dithered for, in printer dots.
 *
 * 32 columns — 58mm paper, the narrower of the two widths a receipt printer usually has. Chosen
 * because it is the harder case: an image that still reads at 384 dots reads at 504, and the
 * operator judging whether a logo survives being reduced to one ink should be shown the version
 * that survives it least well. It is also about as wide as a card in this grid, so nothing is
 * scaled up.
 */
const PREVIEW_DOTS = dotWidth(32);

/**
 * The Assets tab.
 *
 * A top-level section rather than a Settings sub-page: Settings holds install-wide *values*, and a
 * growing library of files is install-wide *content*. It is an asset manager that currently manages
 * one kind — images — and there is deliberately nothing here for kinds that do not exist.
 *
 * **The previews are dithered server-side, by the same code the printer's raster comes from.** That
 * is the whole reason `rasterFor` is called here rather than the stored bytes being handed to the
 * browser: a thermal head has one ink, so what it prints is speckle, and showing the smooth original
 * would show an operator a picture that will never exist on paper.
 *
 * Derived on every render, per {@link rasterFor}'s own note — a logo is a few kilobytes and this is
 * not the print path. If a library ever grows large enough for that to hurt, the fix is a raster
 * cache keyed by asset and width, not a cache of these data URIs.
 */
export default async function AssetsPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("assets:read", "/assets");

	const assets = await listAssets();
	const uploadCap = await maxAssetBytes();
	const acceptedFormats = await enumSetting<AcceptedFormats>("assets.acceptedFormats");

	// One at a time, not `Promise.all`. Rendering a preview decodes the image, and `MAX_IMAGE_DIMENSION`
	// in the asset service is a bound on *one* decode — a 4096-pixel JPEG costs about half a gigabyte
	// while it is being read. Started together, every image on this tab would be holding a bitmap at
	// once and that bound would mean nothing; in sequence the peak stays where the service put it. The
	// cost is latency on a page whose images are, in practice, a few kilobytes each.
	const cards: AssetCardData[] = [];
	for (const asset of assets) {
		cards.push({
			id: asset.id,
			name: asset.name,
			width: asset.width,
			height: asset.height,
			mimeType: asset.mimeType,
			sourceUrl: asset.sourceUrl,
			createdAt: asset.createdAt,
			preview: await previewOf(asset.name),
			previewDots: PREVIEW_DOTS,
		});
	}

	return (
		<div className="flex flex-col gap-5">
			{/* The section's own description is in the top bar; what is left here is the one action
			    this page offers, kept on its own row so it stays put as the grid below changes. */}
			<div className="flex justify-end">
				<UploadDialog
					maxBytes={uploadCap}
					acceptedFormats={acceptedFormats}
					trigger={
						<Button>
							<Plus className="size-3.5" />
							Add image
						</Button>
					}
				/>
			</div>

			{cards.length === 0 ? (
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ImageIcon />
						</EmptyMedia>
						<EmptyTitle>No images yet</EmptyTitle>
						<EmptyDescription>
							An image stored here is printed by name, so a receipt says{" "}
							<span className="font-mono">&lt;image&gt;logo&lt;/image&gt;</span> rather than carrying the picture with
							it. Add one to put a logo on a receipt.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-stretch gap-4">
					{cards.map((asset) => (
						<AssetCard key={asset.id} asset={asset} maxBytes={uploadCap} acceptedFormats={acceptedFormats} />
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Dithers one stored image for the preview width.
 *
 * A failure here is this server disagreeing with itself — these bytes decoded once already, on the
 * way in — so it is logged rather than shown as something the operator did. It is caught per image
 * rather than left to throw because this tab is the only place a bad row can be deleted from, and a
 * page that throws would take the delete button with it.
 *
 * @param name the asset's name
 * @returns a PNG data URI, or null if it could not be rendered
 */
async function previewOf(name: string): Promise<string | null> {
	try {
		return await rasterToPngDataUrl(await rasterFor(name, PREVIEW_DOTS));
	} catch (error) {
		logger.error(`Could not render a preview of asset '${name}'`, error);
		return null;
	}
}
