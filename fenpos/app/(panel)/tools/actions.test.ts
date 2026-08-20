import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { symbolGeometry } from "@/lib/markup/blocks";

/**
 * Tests for what the Tools tab's preview reports.
 *
 * The property worth pinning is that a symbol's height in the preview is the compiler's own
 * measurement rather than a second opinion that happens to agree. Everything else about a preview
 * can be checked by looking at it; this cannot, because two numbers that disagree by a line look
 * exactly like two numbers that agree until a receipt is one line too long to print.
 *
 * The session guard is stubbed rather than satisfied: it redirects, and a redirect is not what
 * these tests are about. Everything downstream of it is the real pipeline against a real database.
 */
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => {},
}));

const { preview } = await import("@/app/(panel)/tools/actions");

const QR_CONTENT = "https://cafe.example/o/123";

describe("preview", () => {
	let deviceId = "";

	beforeAll(async () => {
		const agent = await prisma.agent.create({ data: { name: `preview-${process.pid}` } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "counter", port: "COM1", columns: 32 },
		});
		deviceId = device.id;
	});

	it("draws a symbol at the height the compiler charged it", async () => {
		const result = await preview(deviceId, `<qr>${QR_CONTENT}</qr>`);

		const charged = symbolGeometry({ kind: "QR", content: QR_CONTENT, size: 6 }).heightLines;
		expect(charged).toBeGreaterThan(1);
		expect(result.errors).toEqual([]);
		expect(result.lines?.[0].blocks).toEqual([
			{ spec: { kind: "QR", content: QR_CONTENT, size: 6 }, heightLines: charged },
		]);
		// The same number the budget is checked against, which is the whole point of carrying it.
		expect(result.outputLines).toBe(charged);
	});

	it("carries a symbol's own alignment, and marks it as nothing else", async () => {
		const result = await preview(deviceId, `<align=center><qr>${QR_CONTENT}</qr></align>`);

		expect(result.lines?.[0].align).toBe("CENTER");
		// A symbol is drawn, not annotated: a marker here would be a second description of a line
		// the preview already shows in full.
		expect(result.lines?.[0].marker).toBeNull();
	});

	it("charges a barcode and a PDF417 the heights they were measured at", async () => {
		const result = await preview(
			deviceId,
			["<barcode=EAN13>5901234123457</barcode>", "<pdf417>ORDER-123</pdf417>"].join("\n"),
		);

		expect(result.errors).toEqual([]);
		expect(result.lines?.[0].blocks).toEqual([
			{
				spec: { kind: "BARCODE", content: "5901234123457", system: "EAN13" },
				heightLines: symbolGeometry({ kind: "BARCODE", content: "5901234123457", system: "EAN13" }).heightLines,
			},
		]);
		expect(result.lines?.[1].blocks).toEqual([
			{
				spec: { kind: "PDF417", content: "ORDER-123", errorLevel: 1 },
				heightLines: symbolGeometry({ kind: "PDF417", content: "ORDER-123", errorLevel: 1 }).heightLines,
			},
		]);
	});

	it("marks a drawer pulse without hiding the line it was written on", async () => {
		const result = await preview(deviceId, "Total 5.50<drawer=5>");

		expect(result.lines?.[0].marker).toBe("drawer (pin 5)");
		expect(result.lines?.[0].spans.map((span) => span.text).join("")).toBe("Total 5.50");
		// A pulse touches no paper, so it may not lengthen the receipt.
		expect(result.outputLines).toBe(1);
		expect(result.lines?.[0].blocks).toEqual([]);
	});

	it("leaves a line of text with neither a symbol nor a marker", async () => {
		const result = await preview(deviceId, "Coffee 2.50");

		expect(result.lines?.[0].blocks).toEqual([]);
		expect(result.lines?.[0].marker).toBeNull();
	});
});
