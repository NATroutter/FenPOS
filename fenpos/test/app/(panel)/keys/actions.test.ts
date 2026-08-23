import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Tests for the Keys tab's webhook actions.
 *
 * Registration happens here, in a panel action, rather than through the public API — a key that
 * could aim its own webhook could redirect another integrator's notifications if it leaked. The
 * property worth pinning is that this action refuses exactly what delivery would refuse, using the
 * same `assertDeliverable` the delivery loop calls, so a target the panel accepts can never turn
 * out to be one a delivery attempt goes on to reject.
 *
 * The session guard is stubbed rather than satisfied: it redirects, and a redirect is not what
 * these tests are about. `revalidatePath` is stubbed because it needs a request scope these do not
 * have.
 */
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => {},
}));
vi.mock("next/cache", () => ({
	revalidatePath: () => {},
}));

const { removeWebhook, setWebhook } = await import("@/app/(panel)/keys/actions");

let keyId: string;

beforeEach(async () => {
	await prisma.webhookDelivery.deleteMany();
	await prisma.webhook.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.setting.deleteMany();

	const key = await prisma.apiKey.create({
		data: { name: "till", keyHash: `hash-${Date.now()}`, maskedHint: "abcd" },
	});
	keyId = key.id;
});

describe("setWebhook", () => {
	it("registers a target and returns a secret exactly once", async () => {
		const { secret } = await setWebhook(keyId, "https://93.184.216.34/hook");

		expect(secret).toMatch(/^whsec_/);
		const stored = await prisma.webhook.findUnique({ where: { apiKeyId: keyId } });
		expect(stored?.url).toBe("https://93.184.216.34/hook");
	});

	it("replaces an existing registration, issuing a new secret", async () => {
		const first = await setWebhook(keyId, "https://93.184.216.34/one");
		const second = await setWebhook(keyId, "https://93.184.216.34/two");

		expect(second.secret).not.toBe(first.secret);
		expect((await prisma.webhook.findUnique({ where: { apiKeyId: keyId } }))?.url).toBe("https://93.184.216.34/two");
	});

	it("refuses a target this server would never deliver to", async () => {
		await expect(setWebhook(keyId, "https://127.0.0.1/hook")).rejects.toMatchObject({
			code: "webhook_unreachable",
		});
		await expect(setWebhook(keyId, "not a url")).rejects.toMatchObject({ code: "webhook_unreachable" });
	});

	it("stores nothing when the target is refused", async () => {
		await expect(setWebhook(keyId, "https://127.0.0.1/hook")).rejects.toMatchObject({
			code: "webhook_unreachable",
		});

		expect(await prisma.webhook.findUnique({ where: { apiKeyId: keyId } })).toBeNull();
	});

	it("respects webhooks.allowPlainHttp", async () => {
		await expect(setWebhook(keyId, "http://93.184.216.34/hook")).rejects.toMatchObject({
			code: "webhook_unreachable",
		});
	});
});

describe("removeWebhook", () => {
	it("removes a registration and everything queued for it", async () => {
		await setWebhook(keyId, "https://93.184.216.34/hook");
		const webhook = await prisma.webhook.findUniqueOrThrow({ where: { apiKeyId: keyId } });
		await prisma.webhookDelivery.create({
			data: { webhookId: webhook.id, jobId: "job-1", payload: "{}" },
		});

		await removeWebhook(keyId);

		expect(await prisma.webhook.findUnique({ where: { apiKeyId: keyId } })).toBeNull();
		expect(await prisma.webhookDelivery.count({ where: { webhookId: webhook.id } })).toBe(0);
	});

	it("does nothing, and does not throw, when there is no registration", async () => {
		await expect(removeWebhook(keyId)).resolves.toBeUndefined();
	});
});
