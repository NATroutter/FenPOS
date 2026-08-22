import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

/**
 * `POST /api/v1/print/{agent}/{device}` — idempotent submits.
 *
 * `submitJob` is mocked so these cases are about the header alone: what a real dispatch needs (a
 * connected agent, a compilable body) is covered where it belongs, in the dispatcher's own tests,
 * and standing a WebSocket up here would only make the header's behaviour harder to see.
 *
 * The mock records a job row itself, because the replay path reads one back — a stub that returned
 * an id without writing anything would let a broken replay pass by finding nothing to conflict with.
 * That same real insert is also what makes the concurrency test below genuine: it goes through the
 * database's own unique constraint rather than a fake of what that constraint would do.
 *
 * `next/headers` is mocked because `getClientAddress` reads it, and calling `POST` directly here
 * (rather than through a running server) leaves no request scope for it to read — the same reason
 * `test/app/api/pair/route.test.ts` mocks it.
 */
vi.mock("next/headers", () => ({
	headers: vi.fn(async () => new Headers({ "x-forwarded-for": "203.0.113.5" })),
}));

vi.mock("@/lib/jobs/dispatch", () => ({ submitJob: vi.fn() }));

const { POST } = await import("@/app/api/v1/print/[agent]/[device]/route");
const { submitJob } = await import("@/lib/jobs/dispatch");

let token: string;
let agentName: string;
let agentId: string;
let deviceId: string;

/**
 * Builds a print request and its route context.
 *
 * @param body the JSON body to send
 * @param idempotencyKey the header to present, if any
 * @returns the arguments to spread into `POST`
 */
function call(
	body: unknown,
	idempotencyKey?: string,
): [Request, { params: Promise<{ agent: string; device: string }> }] {
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	if (idempotencyKey !== undefined) {
		headers["idempotency-key"] = idempotencyKey;
	}
	return [
		new Request(`https://fenpos.test/api/v1/print/${agentName}/kitchen`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ agent: agentName, device: "kitchen" }) },
	];
}

beforeEach(async () => {
	await prisma.job.deleteMany();
	await prisma.apiKeyDevice.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	agentName = agent.name;
	agentId = agent.id;
	const device = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 42 },
	});
	deviceId = device.id;

	token = `fp_${Date.now()}_${Math.random()}`;
	await prisma.apiKey.create({
		data: {
			name: "till",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "print" }] },
			devices: { create: [{ deviceId: device.id }] },
		},
	});

	// Cleared, not just re-implemented: the mock is a module-level singleton shared across every
	// `it` in this file, so a call count carried over from the previous test would make an
	// unrelated test's assertion pass or fail for the wrong reason.
	vi.mocked(submitJob).mockClear();

	// Stands in for a real dispatch: writes the row the replay path will read back.
	vi.mocked(submitJob).mockImplementation(async (_deviceId, _body, apiKeyId, idempotency) => {
		const job = await prisma.job.create({
			data: {
				agentId,
				deviceId,
				apiKeyId: apiKeyId ?? null,
				status: "QUEUED",
				lines: 4,
				...(idempotency ? { idempotencyKey: idempotency.key, idempotencyHash: idempotency.hash } : {}),
			},
		});
		return { id: job.id, deviceName: "kitchen", lines: 4 };
	});
});

describe("POST /api/v1/print — Idempotency-Key", () => {
	it("prints normally when no key is sent", async () => {
		const response = await POST(...call({ data: ["hello"] }));

		expect(response.status).toBe(202);
		expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
	});

	it("prints once and replays the same answer for a repeated key", async () => {
		const first = await POST(...call({ data: ["hello"] }, "order-1"));
		const second = await POST(...call({ data: ["hello"] }, "order-1"));

		expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
		expect(await second.json()).toMatchObject({ jobId: (await first.json()).jobId });
		expect(await prisma.job.count()).toBe(1);
	});

	it("marks a replayed response, so a caller can tell it apart from a fresh print", async () => {
		await POST(...call({ data: ["hello"] }, "order-1"));
		const replayed = await POST(...call({ data: ["hello"] }, "order-1"));

		expect(replayed.headers.get("idempotent-replay")).toBe("true");
	});

	it("refuses a repeated key carrying a different body", async () => {
		await POST(...call({ data: ["hello"] }, "order-1"));
		const conflict = await POST(...call({ data: ["goodbye"] }, "order-1"));

		expect(conflict.status).toBe(409);
		expect((await conflict.json()).error).toBe("idempotency_conflict");
		expect(await prisma.job.count()).toBe(1);
	});

	it("treats different keys as different receipts", async () => {
		await POST(...call({ data: ["hello"] }, "order-1"));
		await POST(...call({ data: ["hello"] }, "order-2"));

		expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(2);
	});

	it("scopes keys to the credential", async () => {
		const otherToken = `fp_other_${Date.now()}`;
		await prisma.apiKey.create({
			data: {
				name: "other till",
				keyHash: hashSecret(otherToken),
				maskedHint: "wxyz",
				permissions: { create: [{ permission: "print" }] },
				devices: { create: [{ deviceId }] },
			},
		});

		await POST(...call({ data: ["hello"] }, "order-1"));
		token = otherToken;
		await POST(...call({ data: ["hello"] }, "order-1"));

		expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(2);
	});

	it("refuses a key longer than the header allows", async () => {
		const response = await POST(...call({ data: ["hello"] }, "x".repeat(256)));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_type");
		expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
	});

	it("does not record a key for a request that never became a job", async () => {
		vi.mocked(submitJob).mockRejectedValueOnce(new Error("compile failed"));

		await POST(...call({ data: ["bad"] }, "order-1"));
		vi.mocked(submitJob).mockClear();

		// The retry re-validates rather than replaying, because nothing was ever recorded.
		await POST(...call({ data: ["good"] }, "order-1"));
		expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
	});

	/**
	 * Two requests can present the same key together — a double-tap, or a client retrying the
	 * instant it times out. Both find no existing row and both insert; one wins the database's
	 * unique constraint and the other must lose it safely rather than surface it as a fault.
	 *
	 * This exercises the real race rather than a stand-in for it: `submitJob` is mocked (see the
	 * file doc comment) but its mock performs a genuine `prisma.job.create`, so the two `POST`
	 * calls collide on the actual `(apiKeyId, idempotencyKey)` unique index — the same index and
	 * the same Prisma error the production code path hits. Nothing here pre-decides a winner or
	 * simulates a rejection; the constraint decides, and the assertions only check that both
	 * callers end up with one shared, correct answer regardless of which way it fell.
	 */
	it("resolves two concurrent submits of the same key to one job and one shared answer", async () => {
		const [first, second] = await Promise.all([
			POST(...call({ data: ["hello"] }, "order-1")),
			POST(...call({ data: ["hello"] }, "order-1")),
		]);

		expect(first.status).toBe(202);
		expect(second.status).toBe(202);

		const firstBody = await first.json();
		const secondBody = await second.json();
		expect(secondBody.jobId).toBe(firstBody.jobId);

		expect(await prisma.job.count()).toBe(1);
		expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(2);
	});

	/**
	 * The same race, but with disagreeing bodies. The loser must not replay the winner's receipt —
	 * that would print something the caller of the second request did not ask for — so it has to
	 * come back as the same conflict a sequential retry with a different body would get.
	 */
	it("resolves a concurrent double-submit with different bodies to a conflict, not a replay", async () => {
		const [first, second] = await Promise.all([
			POST(...call({ data: ["hello"] }, "order-1")),
			POST(...call({ data: ["goodbye"] }, "order-1")),
		]);

		const statuses = [first.status, second.status].sort();
		expect(statuses).toEqual([202, 409]);

		const conflict = first.status === 409 ? first : second;
		expect((await conflict.json()).error).toBe("idempotency_conflict");
		expect(await prisma.job.count()).toBe(1);
	});
});
