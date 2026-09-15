/**
 * The small pieces of text the upload dialog composes from the configured `assets.acceptedFormats`.
 *
 * Split from `upload-dialog.tsx` for the same reason `dashboard/prose.ts` is split from that tab's
 * `page.tsx`: this project's vitest config deliberately excludes React
 * (`include: ["test/**\/*.test.ts"]`, `vitest.config.mts`) — a plain `.ts` module is what stays
 * testable.
 *
 * There is a second reason this cannot simply import `lib/assets/dither.ts`'s equivalent pieces:
 * `upload-dialog.tsx` is a Client Component, and `dither.ts` pulls in `jimp` — a decoder nobody
 * wants in the browser bundle for the sake of naming two file formats. So the mapping from
 * `assets.acceptedFormats`'s two values to what the dialog shows is restated here, in a module with
 * no heavy imports, rather than shared with the server-side decode gate.
 */

/** The values `assets.acceptedFormats` may hold. Mirrors `AcceptedFormatsSetting` in `dither.ts`. */
export type AcceptedFormats = "png+jpeg" | "png";

/**
 * The MIME types and extensions a TTF or OTF font may declare itself as, for the file picker's
 * `accept` attribute. Extensions alongside MIME types because a browser reading a font from local
 * disk routinely has no MIME type for it at all — unlike an image, which every operating system
 * already knows `image/png` for — so the attribute has to say `.ttf`/`.otf` to filter the picker on
 * anything but Chrome, which is the one browser that fills the MIME type in for a font by itself.
 */
const FONT_ACCEPT = ".ttf,.otf,font/ttf,font/otf";

/**
 * The file picker's `accept` attribute, matching the configured `assets.acceptedFormats`.
 *
 * **A font is always offered, regardless of the setting.** `assets.acceptedFormats` narrows which
 * *image* formats an install accepts — PNG-only shops exist — and says nothing about fonts, which
 * have exactly two flavours and no equivalent setting to narrow them by.
 *
 * @param formats the configured `assets.acceptedFormats`
 * @returns a comma-separated list of MIME types and extensions for the `accept` attribute
 */
export function acceptAttributeFor(formats: AcceptedFormats): string {
	const images = formats === "png" ? "image/png" : "image/png,image/jpeg";
	return `${images},${FONT_ACCEPT}`;
}

/**
 * Names the accepted formats the way the dialog's description reads, phrased for the configured
 * `assets.acceptedFormats`.
 *
 * Extracted for the same reason `dashboardStatLabel` (`dashboard/prose.ts`), `signInThrottlePhrase`
 * (`lib/auth/rate-limit.ts`) and the rest of that family were: a sentence that names a configured
 * value is exactly the kind of sentence this project has shipped wrong at a boundary before, and
 * `"PNG or JPEG"` was hardcoded here until JPEG became something an install could turn off.
 *
 * @param formats the configured `assets.acceptedFormats`
 * @returns "PNG or JPEG images, and TTF or OTF fonts", or "PNG images, and TTF or OTF fonts" when
 *          JPEG is turned off
 */
export function acceptedFormatsPhrase(formats: AcceptedFormats): string {
	const images = formats === "png" ? "PNG" : "PNG or JPEG";
	return `${images} images, and TTF or OTF fonts`;
}

/**
 * The toast the Add dialog's File tab shows on success, naming what was actually stored.
 *
 * Worth a sentence of its own rather than a fixed "added": the operator chose a file, not a kind, and
 * `createAsset` is what settled which one it turned out to be — from the bytes, not from anything the
 * file picker's filter promised. Saying so is what tells them their upload of `logo.ttf` landed as a
 * font and not as an image that happened to be named like one. The URL tab never calls this: it only
 * ever fetches an image, so there is no answer worth reporting.
 *
 * @param name what markup will refer to it by
 * @param kind what the stored bytes turned out to be — `AssetKind`, in `lib/domain/enums.ts`
 * @returns "logo stored as an image.", or "roboto stored as a font."
 */
export function assetStoredMessage(name: string, kind: "IMAGE" | "FONT"): string {
	return `${name} stored as ${kind === "FONT" ? "a font" : "an image"}.`;
}
