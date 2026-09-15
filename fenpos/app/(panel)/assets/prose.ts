import type { AssetKind } from "@/lib/domain/enums";
import { describeBytes } from "@/lib/format/bytes";

/**
 * The small pieces of text the upload and replace dialogs compose from the configured
 * `assets.acceptedFormats` and from what is being stored.
 *
 * Split from `upload-dialog.tsx` and `replace-dialog.tsx` for the same reason `dashboard/prose.ts`
 * is split from that tab's `page.tsx`: this project's vitest config deliberately excludes React
 * (`include: ["test/**\/*.test.ts"]`, `vitest.config.mts`) — a plain `.ts` module is what stays
 * testable. Every sentence a dialog builds from a configured value or a stored asset's kind belongs
 * here rather than inline in the component, for exactly that reason.
 *
 * There is a second reason this cannot simply import `lib/assets/dither.ts`'s equivalent pieces:
 * both dialogs are Client Components, and `dither.ts` pulls in `jimp` — a decoder nobody wants in
 * the browser bundle for the sake of naming two file formats. So the mapping from
 * `assets.acceptedFormats`'s two values to what a dialog shows is restated here, in a module with
 * no heavy imports (`AssetKind` is a type-only import, erased before the bundle exists, and
 * `describeBytes` is deliberately plain — see its own doc comment), rather than shared with the
 * server-side decode gate.
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
 * Names the accepted image formats alone — "PNG or JPEG", or "PNG" when JPEG is turned off.
 *
 * The one place `assets.acceptedFormats`' two values become words, so `acceptedFormatsPhrase` and
 * `replaceDescription`'s image branch cannot say two different things about the same setting.
 *
 * @param formats the configured `assets.acceptedFormats`
 */
function imageFormatsPhrase(formats: AcceptedFormats): string {
	return formats === "png" ? "PNG" : "PNG or JPEG";
}

/**
 * Names the accepted formats the way the Add dialog's description reads, phrased for the configured
 * `assets.acceptedFormats`.
 *
 * Extracted for the same reason `dashboardStatLabel` (`dashboard/prose.ts`), `signInThrottlePhrase`
 * (`lib/auth/rate-limit.ts`) and the rest of that family were: a sentence that names a configured
 * value is exactly the kind of sentence this project has shipped wrong at a boundary before, and
 * `"PNG or JPEG"` was hardcoded here until JPEG became something an install could turn off.
 *
 * **Always mentions fonts, because the Add dialog's File tab always accepts one.** That is wrong for
 * a context where only one kind can land — see `replaceDescription`, which reuses
 * {@link imageFormatsPhrase} instead of this function for exactly that reason.
 *
 * @param formats the configured `assets.acceptedFormats`
 * @returns "PNG or JPEG images, and TTF or OTF fonts", or "PNG images, and TTF or OTF fonts" when
 *          JPEG is turned off
 */
export function acceptedFormatsPhrase(formats: AcceptedFormats): string {
	return `${imageFormatsPhrase(formats)} images, and TTF or OTF fonts`;
}

/**
 * The Replace dialog's description, phrased for the asset's own fixed kind.
 *
 * **Never mentions the other kind.** `acceptedFormatsPhrase` always names both, which is right for
 * the Add dialog's either-kind File tab and wrong here: `replaceAsset` refuses a font submitted for
 * an image's name or the reverse, so a font offered where only an image can land would just be
 * refused — and saying "or a font" first would read as an invitation this dialog cannot honour. The
 * image branch reuses {@link imageFormatsPhrase} rather than restating the PNG/JPEG ternary a third
 * time.
 *
 * @param kind what is being replaced — fixed, since the service refuses a replacement that changes it
 * @param formats the configured `assets.acceptedFormats`; read only for an image, since a font has
 *        no equivalent setting to narrow its two flavours by
 * @param maxBytes the configured upload cap, in bytes
 * @returns the sentence the dialog's `DialogDescription` renders
 */
export function replaceDescription(kind: AssetKind, formats: AcceptedFormats, maxBytes: number): string {
	if (kind === "FONT") {
		return `A TTF or OTF font, up to ${describeBytes(maxBytes)}. The name stays as it is, so every receipt that already draws this font draws the new one without being edited.`;
	}
	return `${imageFormatsPhrase(formats)} images, up to ${describeBytes(maxBytes)}. The name stays as it is, so every receipt that already prints this image prints the new one without being edited.`;
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
