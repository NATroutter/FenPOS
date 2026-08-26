import { describe, expect, it } from "vitest";
import { totpQr } from "@/lib/auth/totp-qr";

/**
 * The QR is drawn on the server. Asserted structurally rather than pixel-wise: what matters is that
 * something scannable comes back and that it is an SVG the page can inline, not its exact geometry.
 */
describe("totpQr", () => {
	const uri = "otpauth://totp/FenPOS:operator@example.test?secret=JBSWY3DPEHPK3PXP&issuer=FenPOS";

	it("returns an inline SVG", () => {
		const svg = totpQr(uri);
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain("</svg>");
	});

	it("draws a different symbol for a different secret", () => {
		expect(totpQr(uri)).not.toBe(totpQr(uri.replace("JBSWY3DPEHPK3PXP", "KRSXG5CTMVRXEZLU")));
	});

	it("refuses an empty URI rather than drawing an empty symbol", () => {
		expect(() => totpQr("")).toThrow();
	});
});
