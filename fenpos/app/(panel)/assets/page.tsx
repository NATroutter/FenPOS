import { Type as FontIcon, Image as ImageIcon, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AssetCard, type AssetCardData } from "@/app/(panel)/assets/asset-card";
import type { AcceptedFormats } from "@/app/(panel)/assets/prose";
import { UploadDialog } from "@/app/(panel)/assets/upload-dialog";
import { ASSET_PERMISSIONS } from "@/app/(panel)/tab-permits";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fontFace, listAssets, maxAssetBytes, rasterFor } from "@/lib/assets/asset-service";
import { fontSpecimenPngDataUrl } from "@/lib/assets/font-specimen";
import { rasterToPngDataUrl } from "@/lib/assets/preview";
import { permitsFor } from "@/lib/auth/permits";
import { requirePagePermission } from "@/lib/auth/require-permission";
import type { AssetKind } from "@/lib/domain/enums";
import { logger } from "@/lib/logger";
import { dotWidth } from "@/lib/markup/blocks";
import type { FontFace } from "@/lib/raster/glyphs";
import { enumSetting } from "@/lib/settings/settings-service";
import { cn } from "@/lib/utils";

export const metadata = { title: "Assets" };

/** Never cached: the library changes as assets are added and deleted, and previews are derived here. */
export const dynamic = "force-dynamic";

/**
 * The paper width the previews are rendered for, in printer dots.
 *
 * 32 columns — 58mm paper, the narrower of the two widths a receipt printer usually has. Chosen
 * because it is the harder case: an image that still reads at 384 dots reads at 504, and the
 * operator judging whether a logo survives being reduced to one ink should be shown the version
 * that survives it least well. It is also about as wide as a card in this grid, so nothing is
 * scaled up. A font's specimen wraps to the same width, for the same reason: the narrower paper is
 * where a face is most likely to run out of room.
 */
const PREVIEW_DOTS = dotWidth(32);

/**
 * The Assets tab.
 *
 * A top-level section rather than a Settings sub-page: Settings holds install-wide *values*, and a
 * growing library of files is install-wide *content*. It manages both kinds an install can store —
 * images and fonts, sharing one namespace, exactly as `asset-service.ts` stores them — behind a
 * `?kind=` filter rather than as two tabs, because they are one library an operator browses together
 * more often than not.
 *
 * **Every preview is rendered server-side, by the same code the printer's own output comes from.**
 * That is the whole reason `rasterFor` and `fontSpecimenPngDataUrl` are called here rather than the
 * stored bytes being handed to the browser: a thermal head has one ink, so what it prints is speckle
 * or a scan-converted outline, and showing the smooth original — or nothing at all, for a font — would
 * show an operator something that does not exist on paper.
 *
 * Derived on every render, per {@link rasterFor}'s own note — a logo is a few kilobytes and a font a
 * few tens of them, and this is not the print path. If a library ever grows large enough for that to
 * hurt, the fix is a cache keyed by asset and width, not a cache of these data URIs.
 */
export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("assets:read", "/assets");

	const params = await searchParams;
	// Anything but the two real values reads as "no filter", so a stale or hand-edited `?kind=` shows
	// everything rather than an empty grid nobody can explain.
	const kind: AssetKind | undefined = params.kind === "IMAGE" || params.kind === "FONT" ? params.kind : undefined;

	const assets = await listAssets(kind);
	const uploadCap = await maxAssetBytes();
	const acceptedFormats = await enumSetting<AcceptedFormats>("assets.acceptedFormats");
	// Resolved here because a client component cannot read the database. Convenience only — every
	// action is refused again by its own gate; see `permitsFor`.
	const permits = await permitsFor(user, ASSET_PERMISSIONS);

	// The Add dialog is one form over two sources, either of which is reason enough to open it.
	const canAdd = permits["assets:upload"] || permits["assets:import"];

	// One at a time, not `Promise.all`. Rendering a preview decodes an image or rasterises a font's
	// specimen, and `MAX_IMAGE_DIMENSION` in the asset service is a bound on *one* image decode — a
	// 4096-pixel JPEG costs about half a gigabyte while it is being read. Started together, every
	// asset on this tab would be holding its own decode at once and that bound would mean nothing; in
	// sequence the peak stays where the service put it. The cost is latency on a page whose files are,
	// in practice, a few kilobytes to a few tens of megabytes each.
	const cards: AssetCardData[] = [];
	for (const asset of assets) {
		const rendered = asset.kind === "FONT" ? await fontPreview(asset.name) : await imagePreview(asset.name);
		cards.push({
			id: asset.id,
			kind: asset.kind,
			name: asset.name,
			width: asset.width,
			height: asset.height,
			mimeType: asset.mimeType,
			sourceUrl: asset.sourceUrl,
			createdAt: asset.createdAt,
			preview: rendered.preview,
			previewDots: PREVIEW_DOTS,
			family: rendered.family,
			glyphs: rendered.glyphs,
		});
	}

	return (
		<div className="flex flex-col gap-5">
			{/* The section's own description is in the top bar; what is left here is the filter and
			    the one action this page offers, kept on their own row so it stays put as the grid
			    below changes. */}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<KindFilter kind={kind} />

				{!canAdd ? null : (
					<UploadDialog
						maxBytes={uploadCap}
						acceptedFormats={acceptedFormats}
						canUpload={permits["assets:upload"]}
						canImport={permits["assets:import"]}
						trigger={
							<Button>
								<Plus className="size-3.5" />
								Add asset
							</Button>
						}
					/>
				)}
			</div>

			{cards.length === 0 ? (
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyMedia variant="icon">{kind === "FONT" ? <FontIcon /> : <ImageIcon />}</EmptyMedia>
						<EmptyTitle>{emptyTitle(kind)}</EmptyTitle>
						<EmptyDescription>{emptyDescription(kind, canAdd)}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-stretch gap-4">
					{cards.map((asset) => (
						<AssetCard
							key={asset.id}
							asset={asset}
							maxBytes={uploadCap}
							acceptedFormats={acceptedFormats}
							permits={permits}
						/>
					))}
				</div>
			)}
		</div>
	);
}

/** One option `KindFilter` offers, and whether the current view is the one it names. */
interface KindOption {
	label: string;
	href: string;
	active: boolean;
}

/**
 * The All / Images / Fonts filter, in the URL rather than in component state.
 *
 * A `Link`, not a client-side `Tabs`: the page above is a server component that reads `?kind=` and
 * refetches from it, so switching views is an ordinary navigation and needs no state of its own — the
 * same reason the Jobs and Logs tabs' filters write straight into the URL. Styled after `TabsList` and
 * `TabsTrigger` (`components/ui/tabs.tsx`) rather than built from them, because those are Base UI
 * primitives driven by their own selected value and this is three links; matching their look keeps
 * the two reading as one visual language without borrowing a client component this page does not need.
 */
function KindFilter({ kind }: { kind: AssetKind | undefined }) {
	const options: KindOption[] = [
		{ label: "All", href: "/assets", active: kind === undefined },
		{ label: "Images", href: "/assets?kind=IMAGE", active: kind === "IMAGE" },
		{ label: "Fonts", href: "/assets?kind=FONT", active: kind === "FONT" },
	];

	return (
		<div className="inline-flex h-8 w-fit items-center gap-0.5 rounded-lg bg-muted p-[3px] text-muted-foreground">
			{options.map((option) => (
				<Link
					key={option.label}
					href={option.href}
					aria-current={option.active ? "page" : undefined}
					className={cn(
						"rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors",
						option.active ? "bg-background text-foreground shadow-sm" : "text-foreground/60 hover:text-foreground",
					)}
				>
					{option.label}
				</Link>
			))}
		</div>
	);
}

/** The Empty state's title, for whichever kind the filter is narrowed to. */
function emptyTitle(kind: AssetKind | undefined): string {
	if (kind === "FONT") {
		return "No fonts yet";
	}
	if (kind === "IMAGE") {
		return "No images yet";
	}
	return "No assets yet";
}

/** The Empty state's description, naming the tag a receipt would use and whether Add is offered. */
function emptyDescription(kind: AssetKind | undefined, canAdd: boolean): ReactNode {
	const invite = canAdd ? " Add one to put it on a receipt." : "";
	if (kind === "FONT") {
		return (
			<>
				A font stored here is drawn by name, so a receipt says{" "}
				<span className="font-mono">&lt;text font=roboto&gt;text&lt;/text&gt;</span> rather than carrying the face with
				it.
				{invite}
			</>
		);
	}
	if (kind === "IMAGE") {
		return (
			<>
				An image stored here is printed by name, so a receipt says{" "}
				<span className="font-mono">&lt;image&gt;logo&lt;/image&gt;</span> rather than carrying the picture with it.
				{invite}
			</>
		);
	}
	return (
		<>
			An asset — an image or a font — is referenced by name, so a receipt says{" "}
			<span className="font-mono">&lt;image&gt;logo&lt;/image&gt;</span> or{" "}
			<span className="font-mono">&lt;text font=roboto&gt;text&lt;/text&gt;</span> rather than carrying the file with
			it.
			{invite}
		</>
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
 * @returns the preview, with `family` and `glyphs` left null — an image has neither
 */
async function imagePreview(
	name: string,
): Promise<{ preview: string | null; family: string | null; glyphs: number | null }> {
	try {
		return { preview: await rasterToPngDataUrl(await rasterFor(name, PREVIEW_DOTS)), family: null, glyphs: null };
	} catch (error) {
		logger.error(`Could not render a preview of asset '${name}'`, error);
		return { preview: null, family: null, glyphs: null };
	}
}

/**
 * Reads one stored font's own name and glyph count, and renders its specimen.
 *
 * Split into two steps, each with its own failure: `fontFace` reads and parses bytes that were
 * already parsed once on the way in, and a specimen only fails to render on top of that succeeding.
 * A font whose specimen could not be drawn should still show its family and glyph count, exactly as
 * an image whose preview failed still shows its pixel size.
 *
 * @param name the asset's name
 * @returns the specimen, the font's own family name, and its glyph count — any of which may be null
 *          if the corresponding step failed
 */
async function fontPreview(
	name: string,
): Promise<{ preview: string | null; family: string | null; glyphs: number | null }> {
	let face: FontFace;
	try {
		face = await fontFace(name);
	} catch (error) {
		logger.error(`Could not read stored font '${name}'`, error);
		return { preview: null, family: null, glyphs: null };
	}

	const family = face.font.names.fontFamily?.en ?? null;
	const glyphs = face.font.numGlyphs;

	try {
		return { preview: await fontSpecimenPngDataUrl(face, PREVIEW_DOTS), family, glyphs };
	} catch (error) {
		logger.error(`Could not render a specimen of font '${name}'`, error);
		return { preview: null, family, glyphs };
	}
}
