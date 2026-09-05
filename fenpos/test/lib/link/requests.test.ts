import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	awaitReply,
	failRequests,
	newRequestId,
	RequestTimeoutError,
	requestTimeoutPhrase,
	settleReply,
} from "@/lib/link/requests";

/**
 * Tests for request correlation.
 *
 * The property that matters is that no wait is unbounded. A promise nobody settles is a request
 * handler held open until the process restarts, and the panel showing a spinner forever is how
 * that presents to whoever is standing at the printer.
 */
describe("request correlation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("mints a distinct id per request", () => {
		const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));

		expect(ids.size).toBe(100);
	});

	it("delivers a reply to the waiter that asked for it", async () => {
		const id = newRequestId();
		const waiting = awaitReply<{ ok: boolean }>("agent-a", id, 5000);

		expect(settleReply("agent-a", id, { ok: true })).toBe(true);

		await expect(waiting).resolves.toEqual({ ok: true });
	});

	it("keeps two concurrent requests apart", async () => {
		const first = newRequestId();
		const second = newRequestId();
		const waitingFirst = awaitReply<string>("agent-a", first, 5000);
		const waitingSecond = awaitReply<string>("agent-a", second, 5000);

		// Answered out of order on purpose: two operators scanning at once is the case this
		// exists for, and whichever agent replies first must not settle the other's request.
		settleReply("agent-a", second, "second");
		settleReply("agent-a", first, "first");

		await expect(waitingFirst).resolves.toBe("first");
		await expect(waitingSecond).resolves.toBe("second");
	});

	it("fails a request nothing answers", async () => {
		const id = newRequestId();
		const waiting = awaitReply("agent-a", id, 5000);

		vi.advanceTimersByTime(5000);

		await expect(waiting).rejects.toBeInstanceOf(RequestTimeoutError);
	});

	it("says how long it waited, so the message is actionable", async () => {
		const waiting = awaitReply("agent-a", newRequestId(), 15_000);

		vi.advanceTimersByTime(15_000);

		await expect(waiting).rejects.toThrow(/15s/);
	});

	it("drops a reply that arrives after its timeout", async () => {
		const id = newRequestId();
		const waiting = awaitReply("agent-a", id, 1000);
		vi.advanceTimersByTime(1000);
		await expect(waiting).rejects.toBeInstanceOf(RequestTimeoutError);

		// Also what an agent inventing request ids looks like. The same silence makes both
		// harmless, so neither is an error.
		expect(settleReply("agent-a", id, "late")).toBe(false);
	});

	it("drops a reply nobody ever asked for", () => {
		expect(settleReply("agent-a", "never-issued", "surprise")).toBe(false);
	});

	it("fails outstanding requests when their agent goes away", async () => {
		const id = newRequestId();
		const waiting = awaitReply("agent-a", id, 5000);

		expect(failRequests([id], "The agent disconnected.")).toBe(1);

		// Without this, an action started just before a agent dropped would sit spinning for
		// the full timeout over a question that already has an answer.
		await expect(waiting).rejects.toThrow("The agent disconnected.");
	});

	it("ignores unknown ids when failing a batch", () => {
		expect(failRequests(["nothing", "here"], "gone")).toBe(0);
	});

	it("settles a request only once", async () => {
		const id = newRequestId();
		const waiting = awaitReply<string>("agent-a", id, 5000);

		expect(settleReply("agent-a", id, "first")).toBe(true);
		expect(settleReply("agent-a", id, "second")).toBe(false);

		await expect(waiting).resolves.toBe("first");
	});

	it("does not settle a wait with an answer from a different agent", async () => {
		// Correlation is what stops two operators scanning at once from getting each other's
		// answers. It must not also be the only thing standing between one agent and another's
		// reply: an identifier is unguessable today, and that is a property of how it is minted
		// rather than a check anyone made.
		const id = newRequestId();
		const waiting = awaitReply<string>("agent-a", id, 5000);

		expect(settleReply("agent-b", id, "not yours")).toBe(false);
		expect(settleReply("agent-a", id, "yours")).toBe(true);
		await expect(waiting).resolves.toBe("yours");
	});
});

/**
 * `requestTimeoutPhrase` feeds `RequestTimeoutError`'s message with a value that traces back to
 * `link.commandTimeoutSeconds` (5–120) or `link.scanTimeoutSeconds` (5–180) — an operator-configured
 * number reaching a sentence, the exact shape that has broken at a boundary elsewhere in this
 * project ("0 MB", "1 distinct URLs", "1 hours"). Tested at 1 second and at both settings' widest
 * bound, independently of `RequestTimeoutError` itself.
 */
describe("requestTimeoutPhrase", () => {
	it("renders one second correctly", () => {
		expect(requestTimeoutPhrase(1_000)).toBe("1s");
	});

	it("renders the widest configurable bound correctly", () => {
		expect(requestTimeoutPhrase(180_000)).toBe("180s");
	});

	it("rounds rather than truncating a fractional second", () => {
		expect(requestTimeoutPhrase(4_600)).toBe("5s");
	});
});
