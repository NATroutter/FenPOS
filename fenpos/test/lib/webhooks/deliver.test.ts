import * as dns from "node:dns/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PinnedAddress } from "@/lib/assets/fetch-remote";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { setSetting } from "@/lib/settings/settings-service";
import { deliverDue, sweepDeliveriesNow } from "@/lib/webhooks/deliver";
import { verifySignature } from "@/lib/webhooks/signature";

// A named export of a built-in ESM module cannot be `vi.spyOn`'d directly — its module namespace
// is not configurable. Mocked here instead, wrapping the real `lookup` as the default implementation
// so every test but the one that overrides it below still resolves for real.
vi.mock("node:dns/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns/promises")>();
	return { ...actual, lookup: vi.fn(actual.lookup) };
});

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
let apiKeyId: string;

beforeEach(async () => {
	await prisma.webhookDelivery.deleteMany();
	await prisma.webhook.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.setting.deleteMany();

	const key = await prisma.apiKey.create({
		data: { name: "till", keyHash: `hash-${Date.now()}`, maskedHint: "abcd" },
	});
	apiKeyId = key.id;
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
		const send = vi.fn(async (_url: string, _approved: PinnedAddress[], body: string, signature: string) => {
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

	// --- Beyond the brief: a resolution timeout retries rather than settling permanently ---
	//
	// Every other refusal targetRefusal can hand back is a fact about the target — a bad scheme, a
	// blocked address, a hostname with genuinely no address — and stays that way on the next attempt.
	// A resolution timeout is not: the resolver merely failed to answer inside `webhooks.timeoutMs`,
	// which is a fact about this attempt. `dns.lookup` is stubbed to outlast the timeout rather than
	// left to the real resolver, because nothing about a real "DNS took too long" is reproducible on
	// demand.
	it("retries a resolution timeout rather than settling it permanently", async () => {
		await prisma.webhook.update({ where: { id: webhookId }, data: { url: "https://slow-resolver.test/hook" } });
		await setSetting("webhooks.timeoutMs", 250);
		const id = await queue();
		const send = vi.fn(async () => ({ status: 200 }));

		const lookup = vi.mocked(dns.lookup);
		lookup.mockImplementationOnce(
			((): Promise<{ address: string; family: number }[]> =>
				new Promise((resolve) => {
					// Outlasts the 250ms floor comfortably, and unref'd so it cannot hold the test process
					// open after the assertions below have already run.
					const timer = setTimeout(() => resolve([{ address: "93.184.216.34", family: 4 }]), 2_000);
					timer.unref?.();
				})) as unknown as typeof dns.lookup,
		);

		await deliverDue(new Date(), send);

		expect(send).not.toHaveBeenCalled();
		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("PENDING");
		expect(row?.attempts).toBe(1);
		expect(row?.lastError).toMatch(/timed out/i);
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
	// fires. Two distinct orderings matter here, and each needs its own case: two passes whose reads
	// of the due row both land before either claims it (this one — the claim's compare-and-swap on
	// `attempts` is what decides the winner), and a pass that starts while an earlier one's `send` is
	// still genuinely in flight (the next one — that needs the lease, not just the CAS, since the row
	// is still PENDING and still due for as long as nothing has pushed its nextAttemptAt out).
	it("does not double-claim a delivery when two passes read it before either claims it", async () => {
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

	it("does not resend a delivery whose earlier attempt is still in flight when a later pass starts", async () => {
		const id = await queue();
		let releaseSend: (() => void) | undefined;
		let sendStartedResolve: (() => void) | undefined;
		const sendStarted = new Promise<void>((resolve) => {
			sendStartedResolve = resolve;
		});
		const send = vi.fn(async () => {
			sendStartedResolve?.();
			await new Promise<void>((resolve) => {
				releaseSend = resolve;
			});
			return { status: 200 };
		});

		// The first pass claims the row and calls `send`, which hangs until released below — this is
		// deliberately sequential, not Promise.all, so the second pass's `findMany` runs strictly
		// after the first pass's claim has already committed. That is the ordering a claim that is
		// only a compare-and-swap on `attempts`, and not a lease on `nextAttemptAt`, cannot survive:
		// the row is still PENDING and its `nextAttemptAt` is still in the past, so the second pass's
		// due query finds it, and its own CAS against the now-current `attempts` succeeds too.
		const firstPass = deliverDue(new Date(), send);
		await sendStarted;

		const secondPassAttempted = await deliverDue(new Date(), send);

		expect(send).toHaveBeenCalledTimes(1);
		expect(secondPassAttempted).toBe(0);

		releaseSend?.();
		await firstPass;

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("DELIVERED");
		expect(row?.attempts).toBe(1);
	});

	it("does not let a setup failure become an unhandled rejection", async () => {
		const findMany = vi.spyOn(prisma.setting, "findMany").mockRejectedValueOnce(new Error("db exploded"));
		await queue();
		const send = vi.fn(async () => ({ status: 200 }));

		await expect(deliverDue(new Date(), send)).resolves.toBe(0);
		expect(send).not.toHaveBeenCalled();

		findMany.mockRestore();
	});

	// --- A disabled webhook must not starve the queue ---
	//
	// processDelivery's own `enabled` check ran only after a row was already claimed, so a disabled
	// webhook's rows stayed PENDING, still due, and — oldest first — sorted ahead of every other
	// delivery on every later pass. Filtering the due query itself is what stops them ever reaching a
	// claim in the first place.
	it("does not let a disabled webhook's due deliveries block the rest of the batch", async () => {
		const otherKey = await prisma.apiKey.create({
			data: { name: "other", keyHash: `hash-${Date.now()}-disabled`, maskedHint: "wxyz" },
		});
		const disabledWebhook = await prisma.webhook.create({
			data: { apiKeyId: otherKey.id, url: "https://93.184.216.34/hook", secret: "whsec_disabled", enabled: false },
		});
		await prisma.webhookDelivery.create({
			data: { webhookId: disabledWebhook.id, jobId: "job-disabled", payload: "{}" },
		});
		const id = await queue();
		const send = vi.fn(async () => ({ status: 200 }));

		expect(await deliverDue(new Date(), send)).toBe(1);
		expect(send).toHaveBeenCalledTimes(1);

		expect((await prisma.webhookDelivery.findUnique({ where: { id } }))?.status).toBe("DELIVERED");
		const disabledRow = await prisma.webhookDelivery.findFirst({ where: { webhookId: disabledWebhook.id } });
		expect(disabledRow?.status).toBe("PENDING");
		expect(disabledRow?.attempts).toBe(0);
	});

	// --- Revoking a key must stop its webhook ---
	it("does not deliver to a revoked key's webhook", async () => {
		await prisma.apiKey.update({ where: { id: apiKeyId }, data: { revokedAt: new Date() } });
		const id = await queue();
		const send = vi.fn(async () => ({ status: 200 }));

		expect(await deliverDue(new Date(), send)).toBe(0);
		expect(send).not.toHaveBeenCalled();
		expect((await prisma.webhookDelivery.findUnique({ where: { id } }))?.status).toBe("PENDING");
	});

	// --- A settled-as-failed delivery must be visible somewhere an operator reads ---
	it("warns, naming the delivery, the job, the target's host and the reason, when a delivery is given up on", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const id = await queue({ jobId: "job-warn-test" });

		await deliverDue(new Date(), async () => ({ status: 400 }));

		expect(warnSpy).toHaveBeenCalledWith(
			"Webhook delivery failed permanently",
			expect.objectContaining({
				deliveryId: id,
				jobId: "job-warn-test",
				host: "93.184.216.34",
				lastError: expect.stringContaining("400"),
			}),
		);
	});

	// --- redirect: "manual" means a 3xx is exactly as final as a 4xx ---
	it("gives up immediately on a 3xx, which redirect: 'manual' means will never become a 2xx on its own", async () => {
		const id = await queue();

		await deliverDue(new Date(), async () => ({ status: 301 }));

		const row = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(row?.status).toBe("FAILED");
		expect(row?.attempts).toBe(1);
	});

	// --- A losing writer must not clobber a winning one ---
	//
	// Both processDelivery calls below claim, and race, the same row — the first's send hangs until
	// released, so the second's due query (after the first's lease is manually expired, standing in
	// for the real clock outlasting it) claims and settles it first. When the first's send finally
	// resolves, its outcome write must not overwrite what the second already recorded.
	it("does not let a lease-expired attempt's outcome clobber a second claimant's", async () => {
		const id = await queue();
		let releaseFirstSend: (() => void) | undefined;
		let firstSendStarted = false;
		const send = vi.fn(async () => {
			if (!firstSendStarted) {
				firstSendStarted = true;
				await new Promise<void>((resolve) => {
					releaseFirstSend = resolve;
				});
				return { status: 500 };
			}
			return { status: 200 };
		});

		const firstPass = deliverDue(new Date(), send);
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

		// Stands in for the first pass's lease actually expiring, without waiting out webhooks.timeoutMs
		// for real: pushes the row back into the due set for a second pass while the first is still
		// mid-flight, the same ordering "does not resend a delivery whose earlier attempt is still in
		// flight" above proves cannot happen on its own before a lease expires.
		await prisma.webhookDelivery.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });

		expect(await deliverDue(new Date(), send)).toBe(1);
		expect(send).toHaveBeenCalledTimes(2);

		const afterSecond = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(afterSecond?.status).toBe("DELIVERED");
		expect(afterSecond?.attempts).toBe(2);

		releaseFirstSend?.();
		await firstPass;

		const afterFirst = await prisma.webhookDelivery.findUnique({ where: { id } });
		expect(afterFirst?.status).toBe("DELIVERED");
		expect(afterFirst?.attempts).toBe(2);
	});
});

describe("sweepDeliveriesNow", () => {
	it("sweeps the oldest settled deliveries down to the cap, and never a pending one regardless of age", async () => {
		for (let index = 0; index < 10; index++) {
			await prisma.webhookDelivery.create({
				data: {
					webhookId,
					jobId: `settled-${index}`,
					payload: "{}",
					status: index % 2 === 0 ? "DELIVERED" : "FAILED",
					createdAt: new Date(Date.now() - (10 - index) * 60_000),
				},
			});
		}
		await prisma.webhookDelivery.create({
			data: { webhookId, jobId: "still-pending", payload: "{}", createdAt: new Date(0) },
		});

		await sweepDeliveriesNow(5);

		const remaining = await prisma.webhookDelivery.findMany();
		const settledRemaining = remaining.filter((row) => row.status !== "PENDING");
		expect(settledRemaining).toHaveLength(5);
		expect(settledRemaining.map((row) => row.jobId).sort()).toEqual([
			"settled-5",
			"settled-6",
			"settled-7",
			"settled-8",
			"settled-9",
		]);
		expect(remaining.some((row) => row.jobId === "still-pending")).toBe(true);
	});

	it("does nothing when the settled count is already within the cap", async () => {
		await prisma.webhookDelivery.create({ data: { webhookId, jobId: "one", payload: "{}", status: "DELIVERED" } });

		await sweepDeliveriesNow(5);

		expect(await prisma.webhookDelivery.count()).toBe(1);
	});

	it("sweeps settled deliveries down to the configured cap through the real deliverDue settle path", async () => {
		// Shared across every test in this file and persists between them — see the identical reset in
		// test/lib/logs/ingest.test.ts for the same reason: land webhooks.deliverySweepEvery's gate at a
		// known point in this test's own loop below, not at whatever offset earlier tests left it.
		(globalThis as unknown as { fenposWebhookSettles: number | undefined }).fenposWebhookSettles = 0;
		await setSetting("webhooks.maxDeliveryRecords", 100);
		// 10 is webhooks.deliverySweepEvery's declared minimum, so ten real settles below are enough to
		// trip it once rather than needing the (much higher) built-in default.
		await setSetting("webhooks.deliverySweepEvery", 10);

		await prisma.webhookDelivery.createMany({
			data: Array.from({ length: 100 }, (_, index) => ({
				webhookId,
				jobId: `backlog-${index}`,
				payload: "{}",
				status: "DELIVERED",
				createdAt: new Date(Date.now() - (200 - index) * 1000),
			})),
		});
		for (let index = 0; index < 10; index++) {
			await queue({ jobId: `fresh-${index}` });
		}

		await deliverDue(new Date(), async () => ({ status: 200 }));

		// The tenth of these ten real settles lands sweepDeliveriesOccasionally's counter on exactly the
		// configured deliverySweepEvery, firing sweepDeliveriesNow — fire-and-forget from settleFailed's
		// and the DELIVERED write's caller, so the deletion this proves may still be in flight the
		// instant deliverDue resolves.
		await vi.waitFor(
			async () => {
				expect(await prisma.webhookDelivery.count()).toBeLessThanOrEqual(100);
			},
			{ timeout: 5000 },
		);
	});
});
