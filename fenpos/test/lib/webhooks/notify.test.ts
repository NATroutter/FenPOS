import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";
import { queueJobSettled } from "@/lib/webhooks/notify";

/**
 * Turning a settled job into a delivery waiting to be sent.
 *
 * The payload is frozen here rather than read at send time, and that is the decision this file
 * exists to make. A retry three minutes later must describe the job as it was when it settled; a
 * payload rebuilt at each attempt would report whatever the row says now — and by then retention may
 * have deleted it entirely, turning a retry into a delivery about nothing.
 */

let jobId: string;
let keyId: string;

beforeEach(async () => {
	await prisma.webhookDelivery.deleteMany();
	await prisma.webhook.deleteMany();
	await prisma.job.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	const device = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 42 },
	});
	const key = await prisma.apiKey.create({
		data: { name: "till", keyHash: `hash-${Date.now()}`, maskedHint: "abcd" },
	});
	keyId = key.id;
	const job = await prisma.job.create({
		data: {
			agentId: agent.id,
			deviceId: device.id,
			apiKeyId: key.id,
			status: "COMPLETED",
			lines: 12,
			bytes: 480,
			finishedAt: new Date("2026-08-22T10:00:00.000Z"),
		},
	});
	jobId = job.id;
});

/**
 * Registers a subscription for the key that owns the fixture job.
 *
 * @param enabled whether the subscription is switched on
 */
async function subscribe(enabled = true): Promise<void> {
	await prisma.webhook.create({
		data: { apiKeyId: keyId, url: "https://receiver.test/hook", secret: "whsec_x", enabled },
	});
}

describe("queueJobSettled", () => {
	it("queues one delivery carrying the job's outcome", async () => {
		await subscribe();

		await queueJobSettled(jobId);

		const deliveries = await prisma.webhookDelivery.findMany();
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].status).toBe("PENDING");
		expect(deliveries[0].jobId).toBe(jobId);

		const payload = JSON.parse(deliveries[0].payload);
		expect(payload).toEqual({
			event: "job.settled",
			jobId,
			status: "COMPLETED",
			agent: expect.any(String),
			device: "kitchen",
			lines: 12,
			bytes: 480,
			error: null,
			errorMessage: null,
			at: "2026-08-22T10:00:00.000Z",
		});
	});

	it("queues nothing when the key has no subscription", async () => {
		await queueJobSettled(jobId);

		expect(await prisma.webhookDelivery.count()).toBe(0);
	});

	it("queues nothing for a disabled subscription", async () => {
		await subscribe(false);

		await queueJobSettled(jobId);

		expect(await prisma.webhookDelivery.count()).toBe(0);
	});

	it("queues nothing while the install has webhooks switched off", async () => {
		await subscribe();
		await setSetting("webhooks.enabled", false);

		await queueJobSettled(jobId);

		expect(await prisma.webhookDelivery.count()).toBe(0);
	});

	it("queues nothing for a job the panel submitted, which belongs to no key", async () => {
		await subscribe();
		await prisma.job.update({ where: { id: jobId }, data: { apiKeyId: null } });

		await queueJobSettled(jobId);

		expect(await prisma.webhookDelivery.count()).toBe(0);
	});

	it("does not queue twice for the same job, so a repeated terminal report sends once", async () => {
		await subscribe();

		await queueJobSettled(jobId);
		await queueJobSettled(jobId);

		expect(await prisma.webhookDelivery.count()).toBe(1);
	});

	/**
	 * The same guarantee, but raced rather than sequential. Nothing serialises frame processing on
	 * the link (`agent-connection.ts` dispatches `onJobUpdate` fire-and-forget), so two terminal
	 * reports for the same job — the reconnect re-report this module's doc comment names — can both
	 * pass the cheap `findFirst` check before either `create` lands. This exercises the real race
	 * rather than a stand-in for it: both calls hit the actual database, and it is the
	 * `@@unique([webhookId, jobId])` constraint, not application logic, that keeps the loser from
	 * producing a second row.
	 */
	it("resolves two concurrent settle reports for the same job to one delivery", async () => {
		await subscribe();

		await Promise.all([queueJobSettled(jobId), queueJobSettled(jobId)]);

		expect(await prisma.webhookDelivery.count()).toBe(1);
	});

	it("does not throw when the job has already been swept away", async () => {
		await subscribe();
		await prisma.job.deleteMany();

		await expect(queueJobSettled(jobId)).resolves.toBeUndefined();
		expect(await prisma.webhookDelivery.count()).toBe(0);
	});
});
