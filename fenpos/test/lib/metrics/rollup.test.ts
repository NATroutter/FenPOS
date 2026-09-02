import { beforeEach, describe, expect, it } from "vitest";
import { auditDb, metricsDb, prisma } from "@/lib/db";
import { hourStart, runMetricsRollup } from "@/lib/metrics/rollup";

const clients = { db: prisma, metricsDb, auditDb };

async function seedJob(finishedAt: Date, status = "COMPLETED", errorCode: string | null = null) {
	const agent = await prisma.agent.upsert({
		where: { name: "rollup-agent" },
		update: {},
		create: { name: "rollup-agent", status: "OFFLINE" },
	});
	const device = await prisma.device.upsert({
		where: { agentId_name: { agentId: agent.id, name: "rollup-dev" } },
		update: {},
		create: { agentId: agent.id, name: "rollup-dev", port: "COM9" },
	});
	await prisma.job.create({
		data: {
			agentId: agent.id,
			deviceId: device.id,
			status,
			submittedAt: new Date(finishedAt.getTime() - 5000),
			startedAt: new Date(finishedAt.getTime() - 2000),
			finishedAt,
			bytes: 100,
			lines: 4,
			errorCode,
		},
	});
}

beforeEach(async () => {
	await prisma.job.deleteMany();
	await metricsDb.metricJobHourly.deleteMany();
	await metricsDb.metricErrorHourly.deleteMany();
	await metricsDb.metricWatermark.deleteMany();
});

describe("hourStart", () => {
	it("truncates to the UTC hour", () => {
		expect(hourStart(new Date("2026-08-01T10:59:59.999Z"))).toEqual(new Date("2026-08-01T10:00:00Z"));
	});
});

describe("runMetricsRollup", () => {
	it("backfills history on first run", async () => {
		const now = new Date("2026-08-02T12:30:00Z");
		await seedJob(new Date("2026-08-01T10:05:00Z"));
		await seedJob(new Date("2026-08-01T11:20:00Z"), "FAILED", "device_unreachable");
		const { rolledHours } = await runMetricsRollup(clients, now);
		expect(rolledHours).toBeGreaterThan(0);
		const rows = await metricsDb.metricJobHourly.findMany({ orderBy: { bucket: "asc" } });
		expect(rows).toHaveLength(2);
		expect(rows[0].completed).toBe(1);
		expect(rows[1].failed).toBe(1);
		const errors = await metricsDb.metricErrorHourly.findMany();
		expect(errors).toHaveLength(1);
		expect(errors[0].errorCode).toBe("device_unreachable");
	});

	it("is idempotent: a re-run never double-counts", async () => {
		const now = new Date("2026-08-02T12:30:00Z");
		await seedJob(new Date("2026-08-01T10:05:00Z"));
		await runMetricsRollup(clients, now);
		await runMetricsRollup(clients, now);
		const rows = await metricsDb.metricJobHourly.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].completed).toBe(1);
	});

	it("re-rolls the trailing window so late settles are absorbed", async () => {
		const now = new Date("2026-08-02T12:30:00Z");
		await runMetricsRollup(clients, now); // watermark now at 12:00
		// A settle report arrives late for an hour already behind the watermark.
		await seedJob(new Date("2026-08-02T02:10:00Z"));
		await runMetricsRollup(clients, new Date("2026-08-02T13:00:00Z"));
		const rows = await metricsDb.metricJobHourly.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].bucket).toEqual(new Date("2026-08-02T02:00:00Z"));
	});

	it("never rolls the current, incomplete hour", async () => {
		const now = new Date("2026-08-02T12:30:00Z");
		await seedJob(new Date("2026-08-02T12:10:00Z"));
		await runMetricsRollup(clients, now);
		expect(await metricsDb.metricJobHourly.count()).toBe(0);
	});
});
