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

/**
 * Queues one settled webhook delivery, creating its webhook (and that webhook's api key) on first
 * use per test.
 *
 * `createdAt` cannot be set through `create`'s data the normal way — it defaults via `@default(now())`
 * — so it is written with a follow-up `update`, the same two-step `deliver.test.ts` would need for the
 * same reason.
 */
let webhookId: string | undefined;
async function seedDelivery(createdAt: Date, deliveredAt: Date | null = createdAt): Promise<void> {
	if (!webhookId) {
		const key = await prisma.apiKey.create({
			data: { name: "rollup-key", keyHash: `hash-${Math.random()}`, maskedHint: "abcd" },
		});
		const webhook = await prisma.webhook.create({
			data: { apiKeyId: key.id, url: "https://93.184.216.34/hook", secret: "whsec_rollup_test", enabled: true },
		});
		webhookId = webhook.id;
	}
	const delivery = await prisma.webhookDelivery.create({
		data: {
			webhookId,
			jobId: `job-${Math.random()}`,
			payload: "{}",
			status: deliveredAt ? "DELIVERED" : "PENDING",
			deliveredAt,
		},
	});
	await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { createdAt } });
}

beforeEach(async () => {
	await prisma.job.deleteMany();
	await prisma.webhookDelivery.deleteMany();
	await prisma.webhook.deleteMany();
	await prisma.apiKey.deleteMany();
	webhookId = undefined;
	await metricsDb.metricJobHourly.deleteMany();
	await metricsDb.metricErrorHourly.deleteMany();
	await metricsDb.metricWebhookHourly.deleteMany();
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

	// The count-capped sweep in `sweepDeliveriesNow` (lib/webhooks/deliver.ts) can remove the raw
	// `webhookDelivery` rows for an hour that already sits inside the rollup's trailing re-roll
	// window, well before that hour ages out of it. Rolling "zero raw rows" as "zero deliveries" in
	// that case would erase the rolled history the sweep never touches — this is the regression the
	// bucket-skip in `rollWebhooksHour` exists to prevent.
	it("keeps a webhook hour's rolled rows when its raw deliveries are later swept away", async () => {
		const now = new Date("2026-08-02T12:30:00Z");
		await seedDelivery(new Date("2026-08-01T10:05:00Z"));

		await runMetricsRollup(clients, now);
		const bucket = new Date("2026-08-01T10:00:00Z");
		const before = await metricsDb.metricWebhookHourly.findMany({ where: { bucket } });
		expect(before).toHaveLength(1);
		expect(before[0].delivered).toBe(1);
		expect(before[0].queued).toBe(1);
		// Every other hour in the backfilled range (08-01T10:00 through the current hour) had no
		// deliveries at all and must still roll to nothing, proving the ordinary quiet-hour path is
		// untouched by the new bucket-skip below.
		expect(await metricsDb.metricWebhookHourly.count()).toBe(1);

		// Simulates `sweepDeliveriesNow` pruning the raw table down to its count cap: the already-rolled
		// hour's raw rows are gone, but the rolled row itself must survive.
		await prisma.webhookDelivery.deleteMany();

		await runMetricsRollup(clients, now);
		const after = await metricsDb.metricWebhookHourly.findMany({ where: { bucket } });
		expect(after).toHaveLength(1);
		expect(after[0].delivered).toBe(1);
		expect(after[0].queued).toBe(1);
		// A second re-roll of the same window must not leave any *new* rows behind either — only the
		// one bucket's rolled row, preserved, exists.
		expect(await metricsDb.metricWebhookHourly.count()).toBe(1);
	});
});
