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
 * The file picker's `accept` attribute, matching the configured `assets.acceptedFormats`.
 *
 * @param formats the configured `assets.acceptedFormats`
 * @returns a comma-separated list of MIME types for the `accept` attribute
 */
export function acceptAttributeFor(formats: AcceptedFormats): string {
	return formats === "png" ? "image/png" : "image/png,image/jpeg";
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
 * @returns "PNG or JPEG", or "PNG" when JPEG is turned off
 */
export function acceptedFormatsPhrase(formats: AcceptedFormats): string {
	return formats === "png" ? "PNG" : "PNG or JPEG";
}
