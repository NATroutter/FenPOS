import { describe, expect, it } from "vitest";
import { type PanelEvent, publish, subscribe, subscriberCount } from "@/lib/events/bus";

/**
 * Tests for the panel event bus.
 *
 * The property being pinned down is isolation: publishing happens on the link thread, in the
 * middle of processing a frame from a printer, so one broken subscriber must not be able to
 * delay or break a job update for everyone behind it.
 */
describe("event bus", () => {
	const jobEvent: PanelEvent = {
		kind: "job",
		jobId: "job-1",
		status: "COMPLETED",
		agentId: "agent-1",
		deviceName: "kitchen",
		at: new Date().toISOString(),
	};

	it("delivers an event to a subscriber", () => {
		const seen: PanelEvent[] = [];
		const stop = subscribe((event) => seen.push(event));

		publish(jobEvent);
		stop();

		expect(seen).toEqual([jobEvent]);
	});

	it("delivers to every subscriber", () => {
		let first = 0;
		let second = 0;
		const stopFirst = subscribe(() => first++);
		const stopSecond = subscribe(() => second++);

		publish(jobEvent);
		stopFirst();
		stopSecond();

		expect(first).toBe(1);
		expect(second).toBe(1);
	});

	it("stops delivering once unsubscribed", () => {
		let count = 0;
		const stop = subscribe(() => count++);

		publish(jobEvent);
		stop();
		publish(jobEvent);

		expect(count).toBe(1);
	});

	it("keeps delivering to the others when one subscriber throws", () => {
		let delivered = 0;
		const stopBroken = subscribe(() => {
			throw new Error("this subscriber is broken");
		});
		const stopWorking = subscribe(() => delivered++);

		expect(() => publish(jobEvent)).not.toThrow();
		stopBroken();
		stopWorking();

		// A dead browser tab must not be able to stop a printer's updates reaching every other.
		expect(delivered).toBe(1);
	});

	it("drops a subscriber that threw rather than calling it again", () => {
		let calls = 0;
		const stop = subscribe(() => {
			calls++;
			throw new Error("still broken");
		});

		publish(jobEvent);
		publish(jobEvent);
		stop();

		// Its stream is broken by definition — whatever failed was its own write — so keeping it
		// would mean throwing on every publish forever.
		expect(calls).toBe(1);
	});

	it("publishes to nobody without complaint", () => {
		const before = subscriberCount();

		expect(() => publish(jobEvent)).not.toThrow();
		expect(subscriberCount()).toBe(before);
	});

	it("counts live subscribers", () => {
		const before = subscriberCount();
		const stop = subscribe(() => {});

		expect(subscriberCount()).toBe(before + 1);
		stop();
		expect(subscriberCount()).toBe(before);
	});
});
