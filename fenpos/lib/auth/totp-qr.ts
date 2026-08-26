import "server-only";
import bwip from "bwip-js/node";

/**
 * The enrolment URI as a QR symbol, drawn on the server.
 *
 * bwip-js is already a dependency — `lib/markup/blocks.ts` draws every barcode a receipt can carry
 * with it — and it speaks `qrcode` alongside the retail symbologies, so a second QR library would
 * be a second copy of the same code for one image. Its `toSVG` is synchronous, which is why this
 * function is too.
 *
 * SVG rather than a PNG data URI: it is markup the page inlines, so it scales to whatever the
 * dialog gives it and adds no bytes of base64 to a response that also carries the recovery codes.
 *
 * @param uri the `otpauth:` URI from the plugin
 * @returns SVG markup, ready to inline
 * @throws Error when the URI is empty or bwip-js cannot encode it
 */
export function totpQr(uri: string): string {
	if (uri === "") {
		// bwip-js draws a valid, empty symbol for an empty string. An operator would scan it, their
		// authenticator would accept nothing, and the failure would surface as a wrong code minutes
		// later with nothing to point at.
		throw new Error("Cannot draw a QR for an empty enrolment URI");
	}
	return bwip.toSVG({ bcid: "qrcode", text: uri, scale: 1 });
}
