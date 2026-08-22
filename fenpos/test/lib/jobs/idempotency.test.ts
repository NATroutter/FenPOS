import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { bodyHash, findReplay } from "@/lib/jobs/idempotency";

/**
 * Deciding what a repeated `Idempotency-Key` means.
 *
 * Three outcomes, and the third is the one that earns this module its own file: a key reused with a
 * *different* body must be refused rather than replayed. Replaying it would print the first receipt
 * again while the caller believes they submitted the second — a wrong receipt handed to a customer,
 * produced by the mechanism that exists to prevent exactly that.
 */

let keyId: string;
let deviceId: string;
let agentId: string;

beforeEach(async () => {
	await prisma.job.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `agent-${Date.now()}` } });
	agentId = agent.id;
	const device = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM1", columns: 42 },
	});
	deviceId = device.id;
	const key = await prisma.apiKey.create({
		data: { name: "till", keyHash: `hash-${Date.now()}`, maskedHint: "abcd" },
	});
	keyId = key.id;
});

describe("bodyHash", () => {
	it("is stable for the same bytes", () => {
		expect(bodyHash('{"data":["hi"]}')).toBe(bodyHash('{"data":["hi"]}'));
	});

	it("differs for different bytes, including whitespace", () => {
		expect(bodyHash('{"data":["hi"]}')).not.toBe(bodyHash('{"data":["ho"]}'));
		expect(bodyHash('{"data":["hi"]}')).not.toBe(bodyHash('{"data": ["hi"]}'));
	});
});

describe("findReplay", () => {
	it("reports nothing when the key has not been used", async () => {
		expect(await findReplay(keyId, "order-1", bodyHash("{}"))).toBeNull();
	});

	it("returns the original job when the key is reused with the same body", async () => {
		const job = await prisma.job.create({
			data: {
				agentId,
				deviceId,
				apiKeyId: keyId,
				status: "COMPLETED",
				lines: 12,
				idempotencyKey: "order-1",
				idempotencyHash: bodyHash("{}"),
			},
		});

		const replay = await findReplay(keyId, "order-1", bodyHash("{}"));

		expect(replay).toEqual({ jobId: job.id, status: "COMPLETED", deviceName: "kitchen", lines: 12 });
	});

	it("refuses the key when it is reused with a different body", async () => {
		await prisma.job.create({
			data: {
				agentId,
				deviceId,
				apiKeyId: keyId,
				status: "QUEUED",
				idempotencyKey: "order-1",
				idempotencyHash: bodyHash("{}"),
			},
		});

		await expect(findReplay(keyId, "order-1", bodyHash('{"data":[]}'))).rejects.toMatchObject({
			code: "idempotency_conflict",
		});
	});

	it("scopes keys to the credential, so two integrators may use the same one", async () => {
		const other = await prisma.apiKey.create({
			data: { name: "other", keyHash: `hash-${Date.now()}-b`, maskedHint: "wxyz" },
		});
		await prisma.job.create({
			data: {
				agentId,
				deviceId,
				apiKeyId: other.id,
				status: "COMPLETED",
				idempotencyKey: "order-1",
				idempotencyHash: bodyHash("{}"),
			},
		});

		expect(await findReplay(keyId, "order-1", bodyHash("{}"))).toBeNull();
	});
});
