import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { compilePreview } from "@/lib/jobs/preview";

/**
 * Compiling markup without printing it.
 *
 * The property this file exists to pin is that a preview settles everything a print would and then
 * stops: the same wrapping, the same codepage rejections, the same limits — and no job row, no
 * agent, no paper. A preview that took a different path through the compiler would be a preview of
 * something the printer will not produce, which is worse than no preview at all.
 */

let deviceId: string;

beforeEach(async () => {
	await prisma.job.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	const device = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 20, codepage: "CP858" },
	});
	deviceId = device.id;
});

describe("compilePreview", () => {
	it("returns the lines a print would produce", async () => {
		const result = await compilePreview(deviceId, { data: ["Total 5.50"] });

		expect(result.errors).toEqual([]);
		expect(result.lines).not.toBeNull();
		expect(result.lines?.[0].spans.map((span) => span.text).join("")).toBe("Total 5.50");
	});

	it("wraps to the device's width, not to some other number", async () => {
		const result = await compilePreview(deviceId, { data: ["A".repeat(30)] });

		expect(result.columns).toBe(20);
		expect(result.lines?.length).toBe(2);
	});

	it("reports the measurements a caller checks their receipt against", async () => {
		const result = await compilePreview(deviceId, { data: ["one", "two"] });

		expect(result.outputLines).toBeGreaterThan(0);
		expect(result.maxOutputLines).toBeGreaterThan(0);
		expect(result.linefeed).toBe("LF");
	});

	it("reports bad markup as an error carrying its position, and compiles nothing", async () => {
		const result = await compilePreview(deviceId, { data: ["<bold>unclosed"] });

		expect(result.lines).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].code).toBe("unclosed_tag");
		expect(result.errors[0].line).toBe(1);
	});

	it("reports every bad element, not only the first", async () => {
		const result = await compilePreview(deviceId, { data: ["<bold>a", "<nope>b</nope>"] });

		expect(result.errors.length).toBeGreaterThan(1);
	});

	it("reports a request-level failure without a line, because it belongs to the whole body", async () => {
		const result = await compilePreview(deviceId, { data: "not an array" });

		expect(result.errors[0].line).toBeNull();
	});

	it("creates no job row, ever", async () => {
		await compilePreview(deviceId, { data: ["Total 5.50"] });
		await compilePreview(deviceId, { data: ["<bold>unclosed"] });

		expect(await prisma.job.count()).toBe(0);
	});

	it("reports an unknown device as an error rather than throwing", async () => {
		const result = await compilePreview("no-such-device", { data: ["hi"] });

		expect(result.errors[0].code).toBe("unknown_device");
	});
});
