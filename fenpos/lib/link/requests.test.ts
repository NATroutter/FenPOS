import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitReply, failRequests, newRequestId, RequestTimeoutError, settleReply } from "@/lib/link/requests";

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
		const waiting = awaitReply<{ ok: boolean }>(id);

		expect(settleReply(id, { ok: true })).toBe(true);

		await expect(waiting).resolves.toEqual({ ok: true });
	});

	it("keeps two concurrent requests apart", async () => {
		const first = newRequestId();
		const second = newRequestId();
		const waitingFirst = awaitReply<string>(first);
		const waitingSecond = awaitReply<string>(second);

		// Answered out of order on purpose: two operators scanning at once is the case this
		// exists for, and whichever agent replies first must not settle the other's request.
		settleReply(second, "second");
		settleReply(first, "first");

		await expect(waitingFirst).resolves.toBe("first");
		await expect(waitingSecond).resolves.toBe("second");
	});

	it("fails a request nothing answers", async () => {
		const id = newRequestId();
		const waiting = awaitReply(id, 5000);

		vi.advanceTimersByTime(5000);

		await expect(waiting).rejects.toBeInstanceOf(RequestTimeoutError);
	});

	it("says how long it waited, so the message is actionable", async () => {
		const waiting = awaitReply(newRequestId(), 15_000);

		vi.advanceTimersByTime(15_000);

		await expect(waiting).rejects.toThrow(/15s/);
	});

	it("drops a reply that arrives after its timeout", async () => {
		const id = newRequestId();
		const waiting = awaitReply(id, 1000);
		vi.advanceTimersByTime(1000);
		await expect(waiting).rejects.toBeInstanceOf(RequestTimeoutError);

		// Also what an agent inventing request ids looks like. The same silence makes both
		// harmless, so neither is an error.
		expect(settleReply(id, "late")).toBe(false);
	});

	it("drops a reply nobody ever asked for", () => {
		expect(settleReply("never-issued", "surprise")).toBe(false);
	});

	it("fails outstanding requests when their agent goes away", async () => {
		const id = newRequestId();
		const waiting = awaitReply(id);

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
		const waiting = awaitReply<string>(id);

		expect(settleReply(id, "first")).toBe(true);
		expect(settleReply(id, "second")).toBe(false);

		await expect(waiting).resolves.toBe("first");
	});
});
