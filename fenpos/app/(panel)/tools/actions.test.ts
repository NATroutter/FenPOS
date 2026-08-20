import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { dotWidth, type SymbolSpec, symbolGeometry, symbolSvg } from "@/lib/markup/blocks";

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

/** The width of the printer these previews are compiled against. */
const COLUMNS = 32;

/**
 * The block a symbol should arrive as, drawn and measured from the shared module.
 *
 * Built from `blocks.ts` rather than from literals: the property under test is that the preview
 * reports what that module says, so restating its answers here would only pin them to themselves.
 *
 * @param spec the symbol
 * @returns the block the preview should carry for it
 */
function drawn(spec: SymbolSpec) {
	const geometry = symbolGeometry(spec);
	return {
		spec,
		svg: symbolSvg(spec),
		heightLines: geometry.heightLines,
		widthFraction: geometry.widthDots / dotWidth(COLUMNS),
	};
}

describe("preview", () => {
	let deviceId = "";
	let agentId = "";

	beforeAll(async () => {
		const agent = await prisma.agent.create({ data: { name: `preview-${process.pid}` } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "counter", port: "COM1", columns: COLUMNS },
		});
		agentId = agent.id;
		deviceId = device.id;
	});

	it("draws a symbol at the size the compiler charged it", async () => {
		const spec = { kind: "QR", content: QR_CONTENT, size: 6 } as const;
		const result = await preview(deviceId, `<qr>${QR_CONTENT}</qr>`);

		const charged = symbolGeometry(spec);
		expect(charged.heightLines).toBeGreaterThan(1);
		expect(result.errors).toEqual([]);
		// Its width arrives as a share of 32 columns of paper, which is the number that answers
		// whether it fits across the sheet.
		expect(result.lines?.[0].blocks).toEqual([drawn(spec)]);
		// The same number the budget is checked against, which is the whole point of carrying it.
		expect(result.outputLines).toBe(charged.heightLines);
	});

	it("measures a symbol's width against the paper it is being previewed on", async () => {
		const narrow = await prisma.device.create({
			data: { agentId: agentId, name: "narrow", port: "COM2", columns: 32 },
		});
		const wide = await prisma.device.create({
			data: { agentId: agentId, name: "wide", port: "COM3", columns: 42 },
		});

		const onNarrow = await preview(narrow.id, `<qr>${QR_CONTENT}</qr>`);
		const onWide = await preview(wide.id, `<qr>${QR_CONTENT}</qr>`);

		// The same symbol takes a smaller share of a wider printer's paper. Drawn off the vertical
		// scale instead, both would be the same size and neither would answer "does this fit".
		const narrowShare = onNarrow.lines?.[0].blocks[0].widthFraction ?? 0;
		const wideShare = onWide.lines?.[0].blocks[0].widthFraction ?? 0;
		expect(narrowShare).toBeGreaterThan(wideShare);
		expect(narrowShare / wideShare).toBeCloseTo(42 / 32, 10);
	});

	it("reports a symbol too wide for the paper as wider than the paper", async () => {
		// A Code 128 long enough to outgrow 32 columns. Nothing refuses it, so the only thing
		// standing between it and a preview that looks printable is this figure.
		const result = await preview(deviceId, `<barcode=CODE128>${"ORDER-1234567890".repeat(4)}</barcode>`);

		expect(result.errors).toEqual([]);
		expect(result.lines?.[0].blocks[0].widthFraction).toBeGreaterThan(1);
	});

	it("carries a symbol's own alignment, and marks it as nothing else", async () => {
		const result = await preview(deviceId, `<align=center><qr>${QR_CONTENT}</qr></align>`);

		expect(result.lines?.[0].align).toBe("CENTER");
		// A symbol is drawn, not annotated: a marker here would be a second description of a line
		// the preview already shows in full.
		expect(result.lines?.[0].marker).toBeNull();
	});

	it("charges a barcode and a PDF417 the sizes they were measured at", async () => {
		const barcode = { kind: "BARCODE", content: "5901234123457", system: "EAN13" } as const;
		const pdf417 = { kind: "PDF417", content: "ORDER-123", errorLevel: 1 } as const;

		const result = await preview(
			deviceId,
			["<barcode=EAN13>5901234123457</barcode>", "<pdf417>ORDER-123</pdf417>"].join("\n"),
		);

		expect(result.errors).toEqual([]);
		expect(result.lines?.[0].blocks).toEqual([drawn(barcode)]);
		expect(result.lines?.[1].blocks).toEqual([drawn(pdf417)]);
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
