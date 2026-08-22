import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { bodyHash, findReplay, isIdempotencyKeyRace } from "@/lib/jobs/idempotency";

/**
 * Deciding what a repeated `Idempotency-Key` means.
 *
 * Three outcomes, and the last two are why this module earns its own file: a key reused with a
 * *different* body, or with the same body against a *different* device, must be refused rather
 * than replayed. Replaying either would tell the caller something happened that did not — a wrong
 * receipt printed to the wrong printer, or a receipt the second printer never saw at all — produced
 * by the mechanism that exists to prevent exactly that.
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
		expect(await findReplay(keyId, "order-1", bodyHash("{}"), deviceId)).toBeNull();
	});

	it("returns the original job when the key is reused with the same body and device", async () => {
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

		const replay = await findReplay(keyId, "order-1", bodyHash("{}"), deviceId);

		// status is always "QUEUED" — what the original 202 said — even though the row above is
		// COMPLETED. A replay answers what the caller was told, not the job's live state.
		expect(replay).toEqual({ jobId: job.id, status: "QUEUED", deviceName: "kitchen", lines: 12 });
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

		await expect(findReplay(keyId, "order-1", bodyHash('{"data":[]}'), deviceId)).rejects.toMatchObject({
			code: "idempotency_conflict",
		});
	});

	it("refuses the key when it is reused for a different device, even with the same body", async () => {
		await prisma.job.create({
			data: {
				agentId,
				deviceId,
				apiKeyId: keyId,
				status: "QUEUED",
				idempotencyKey: "order-1041",
				idempotencyHash: bodyHash('{"data":["order 1041"]}'),
			},
		});
		const bar = await prisma.device.create({
			data: { agentId, name: "bar", port: "COM2", columns: 42 },
		});

		// Same key, same body — a kitchen ticket and a bar ticket for the same order — addressed to
		// a different printer. The hash matches, so only the device check catches this.
		await expect(findReplay(keyId, "order-1041", bodyHash('{"data":["order 1041"]}'), bar.id)).rejects.toMatchObject({
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

		expect(await findReplay(keyId, "order-1", bodyHash("{}"), deviceId)).toBeNull();
	});
});

describe("isIdempotencyKeyRace", () => {
	/**
	 * Builds a `PrismaClientKnownRequestError`-shaped value the way the installed driver adapter
	 * (`better-sqlite3`, confirmed empirically against this project's own client) actually reports a
	 * unique constraint violation, so these hand-built objects match a real error rather than a
	 * guessed one.
	 *
	 * @param fields the mapped column names the constraint names
	 * @returns an error shaped like Prisma's own `P2002`
	 */
	function fakeUniqueConstraintError(fields: string[]): unknown {
		return {
			code: "P2002",
			meta: {
				modelName: "Job",
				driverAdapterError: {
					name: "DriverAdapterError",
					cause: {
						originalCode: "SQLITE_CONSTRAINT_UNIQUE",
						kind: "UniqueConstraintViolation",
						constraint: { fields },
					},
				},
			},
		};
	}

	it("recognises the idempotency key constraint", () => {
		expect(isIdempotencyKeyRace(fakeUniqueConstraintError(["api_key_id", "idempotency_key"]))).toBe(true);
	});

	/**
	 * A Prisma upgrade, or a schema change adding another two-column unique constraint on the
	 * `jobs` table, must not be silently mistaken for this one — a broad match here would answer an
	 * unrelated insert failure with someone else's job.
	 */
	it("does not match an unrelated two-column unique constraint", () => {
		expect(isIdempotencyKeyRace(fakeUniqueConstraintError(["agent_id", "device_id"]))).toBe(false);
	});

	/** A single-column violation, such as a primary key collision, is not this constraint either. */
	it("does not match a primary-key violation", () => {
		expect(isIdempotencyKeyRace(fakeUniqueConstraintError(["id"]))).toBe(false);
	});
});
