import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";
import { deliverDue } from "@/lib/webhooks/deliver";
import { verifySignature } from "@/lib/webhooks/signature";

/**
 * Sending queued deliveries, and deciding what a failure means.
 *
 * The distinction that matters is between a receiver that is *down* and one that is *refusing*. A
 * 500 or a timeout is worth retrying — the receiver may be restarting. A 400 is not: a target that
 * rejects the shape of a delivery will reject the same bytes just as firmly in ten minutes, and
 * retrying is only load. 408 and 429 are the exceptions, because both explicitly mean "later".
 */

const SECRET = "whsec_deliver_test";
let webhookId: string;

beforeEach(async () => {
	await prisma.webhookDelivery.deleteMany();
	await prisma.webhook.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.setting.deleteMany();

	const key = await prisma.apiKey.create({
		data: { name: "till", keyHash: `hash-${Date.now()}`, maskedHint: "abcd" },
	});
	// A literal public address, not a hostname: `targetRefusal` resolves a hostname for real before
	// checking it, and `receiver.test` — the placeholder used elsewhere in this suite, e.g.
	// notify.test.ts, where nothing ever connects to it — is an IANA-reserved TLD guaranteed never to
	// resolve (RFC 6761). Here it would make every happy-path case below indistinguishable from the
	// "does not resolve" refusal, for a reason with nothing to do with what each test is about. A
	// literal address needs no resolver at all (`isIP` short-circuits it in `targetRefusal`), which
	// is also the stricter reading of "no test in this suite may open a socket": not merely no HTTP
	// connection (deliverDue never makes one directly either way — `send` is always a stub), but no
	// DNS query. Same address `fetch-remote.test.ts` calls `PUBLIC_V4` and documents as safe to reuse.
	const webhook = await prisma.webhook.create({
		data: { apiKeyId: key.id, url: "https://93.184.216.34/hook", secret: SECRET, enabled: true },
	});
	webhookId = webhook.id;
});

/**
 * Queues one delivery.
 *
 * @param overrides fields to set on the delivery row
 * @returns the created delivery's id
 */
async function queue(overrides: Record<string, unknown> = {}): Promise<string> {
	const delivery = await prisma.webhookDelivery.create({
		data: {
			webhookId,
			jobId: `job-${Math.random()}`,
			payload: '{"event":"job.settled"}',
			...overrides,
		},
	});
	return delivery.id;
}

describe("deliverDue", () => {
	it("sends a pending delivery and marks it delivered", async () => {
		const id = await queue();
		const send = vi.fn(async () => ({ status: 200 }));

		expect(await deliverDue(new Date(), send)).toBe(1);
		expect(send).toHaveBeenCalledTimes(1);

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("DELIVERED");
		expect(row?.deliveredAt).not.toBeNull();
	});

	it("signs what it sends, verifiably", async () => {
		await queue({ payload: '{"event":"job.settled","jobId":"job-9"}' });
		const seen: { body: string; signature: string }[] = [];
		const send = vi.fn(async (_url: string, body: string, signature: string) => {
			seen.push({ body, signature });
			return { status: 200 };
		});

		await deliverDue(new Date(), send);

		expect(seen).toHaveLength(1);
		expect(verifySignature(SECRET, seen[0].body, seen[0].signature)).toBe(true);
	});

	it("retries a 500 with a backoff, rather than giving up", async () => {
		await setSetting("webhooks.retryBackoffSeconds", 10);
		const now = new Date("2026-08-22T10:00:00.000Z");
		// Pinned rather than left at `queue()`'s row-creation default: the default is the real wall
		// clock, and this test's `now` is a fixed calendar moment that is not reliably in the future
		// of it — it is only "due" here because it is explicitly no later than `now`.
		const id = await queue({ nextAttemptAt: now });

		await deliverDue(now, async () => ({ status: 500 }));

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("PENDING");
		expect(row?.attempts).toBe(1);
		expect(row?.nextAttemptAt.toISOString()).toBe("2026-08-22T10:00:10.000Z");
	});

	it("doubles the wait on each further attempt", async () => {
		await setSetting("webhooks.retryBackoffSeconds", 10);
		const now = new Date("2026-08-22T10:00:00.000Z");
		// See the pinned `nextAttemptAt` note above: without it, this row's due date is the real wall
		// clock at creation, not this test's fixed `now`.
		const id = await queue({ attempts: 2, nextAttemptAt: now });

		await deliverDue(now, async () => ({ status: 500 }));

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.nextAttemptAt.toISOString()).toBe("2026-08-22T10:00:40.000Z");
	});

	// --- Beyond the brief: an unbounded backoff ---
	//
	// `webhooks.retryBackoffSeconds` (up to 3600) and `webhooks.maxAttempts` (up to 20) are each
	// bounded on their own, but nothing stops an install setting both near their ceiling — and the
	// doubling between them is not bounded at all. Without a cap, a late attempt under that
	// configuration computes a wait on the order of decades.
	it("does not let the doubling schedule a retry years out", async () => {
		await setSetting("webhooks.retryBackoffSeconds", 3600);
		await setSetting("webhooks.maxAttempts", 20);
		const now = new Date("2026-08-22T10:00:00.000Z");
		const id = await queue({ attempts: 18, nextAttemptAt: now });

		await deliverDue(now, async () => ({ status: 500 }));

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("PENDING");
		// Uncapped this would be 3600 * 2^18 seconds out — decades away. Capped, it is one day.
		expect(row?.nextAttemptAt.toISOString()).toBe("2026-08-23T10:00:00.000Z");
	});

	it("gives up once the attempt ceiling is reached", async () => {
		await setSetting("webhooks.maxAttempts", 3);
		const id = await queue({ attempts: 2 });

		await deliverDue(new Date(), async () => ({ status: 500 }));

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("FAILED");
		expect(row?.attempts).toBe(3);
	});

	it("gives up immediately on a 400, which will not become a 200", async () => {
		const id = await queue();

		await deliverDue(new Date(), async () => ({ status: 400 }));

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("FAILED");
		expect(row?.attempts).toBe(1);
	});

	it("retries a 429 and a 408, which explicitly mean 'later'", async () => {
		const rateLimited = await queue();
		await deliverDue(new Date(), async () => ({ status: 429 }));
		expect((await prisma.webhookDelivery.findUnique({ where: { id: rateLimited } }))?.status).toBe("PENDING");

		await prisma.webhookDelivery.deleteMany();
		const timedOut = await queue();
		await deliverDue(new Date(), async () => ({ status: 408 }));
		expect((await prisma.webhookDelivery.findUnique({ where: { id: timedOut } }))?.status).toBe("PENDING");
	});

	it("retries a transport failure and records why", async () => {
		const id = await queue();

		await deliverDue(new Date(), async () => {
			throw new Error("socket hang up");
		});

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("PENDING");
		expect(row?.lastError).toContain("socket hang up");
	});

	it("leaves a delivery alone until its next attempt is due", async () => {
		await queue({ nextAttemptAt: new Date("2026-08-22T11:00:00.000Z") });
		const send = vi.fn(async () => ({ status: 200 }));

		expect(await deliverDue(new Date("2026-08-22T10:00:00.000Z"), send)).toBe(0);
		expect(send).not.toHaveBeenCalled();
	});

	it("sends nothing while the install has webhooks switched off", async () => {
		await queue();
		await setSetting("webhooks.enabled", false);
		const send = vi.fn(async () => ({ status: 200 }));

		expect(await deliverDue(new Date(), send)).toBe(0);
		expect(send).not.toHaveBeenCalled();
	});

	it("refuses a target that resolves somewhere it must not reach", async () => {
		await prisma.webhook.update({ where: { id: webhookId }, data: { url: "https://127.0.0.1/hook" } });
		const id = await queue();
		const send = vi.fn(async () => ({ status: 200 }));

		await deliverDue(new Date(), send);

		expect(send).not.toHaveBeenCalled();
		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("FAILED");
		expect(row?.lastError).toMatch(/loopback/i);
	});

	it("refuses plain http unless the install allows it", async () => {
		await prisma.webhook.update({ where: { id: webhookId }, data: { url: "http://receiver.test/hook" } });
		const id = await queue();
		const send = vi.fn(async () => ({ status: 200 }));

		await deliverDue(new Date(), send);

		expect(send).not.toHaveBeenCalled();
		expect((await prisma.webhookDelivery.findUnique({ where: { id } }))?.status).toBe("FAILED");
	});

	// --- Beyond the brief: overlapping passes ---
	//
	// Task 11 calls deliverDue on a timer, so a slow pass can still be in flight when the next one
	// fires. None of the cases above exercise that, so this one does directly: two passes started
	// together, racing over one delivery.
	it("does not send the same delivery twice when two passes overlap", async () => {
		const id = await queue();
		let inFlight = 0;
		let sawConcurrent = false;
		const send = vi.fn(async () => {
			inFlight += 1;
			sawConcurrent ||= inFlight > 1;
			// Yields the event loop long enough for a second overlapping deliverDue call to reach
			// its own claim attempt on this same row before this one resolves.
			await new Promise((resolve) => setTimeout(resolve, 20));
			inFlight -= 1;
			return { status: 200 };
		});

		const [first, second] = await Promise.all([deliverDue(new Date(), send), deliverDue(new Date(), send)]);

		expect(send).toHaveBeenCalledTimes(1);
		expect(sawConcurrent).toBe(false);
		expect(first + second).toBe(1);

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("DELIVERED");
		expect(row?.attempts).toBe(1);
	});
});
