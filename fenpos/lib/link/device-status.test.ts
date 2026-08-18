import { beforeEach, describe, expect, it } from "vitest";
import { clearAgentStatus, getAgentStatus, getDeviceStatus, recordStatus } from "@/lib/link/device-status";

/**
 * Tests for the observed-state registry.
 *
 * The distinction this holds is between what an operator configured and what is true right now.
 * Confusing the two is how a panel ends up showing a printer as connected long after the machine
 * driving it went away — a confident wrong answer, which is worse than an obvious absence.
 */
describe("device status", () => {
	const agent = "agent-1";

	beforeEach(() => {
		clearAgentStatus(agent);
		clearAgentStatus("other");
	});

	const report = (name: string, overrides: Partial<{ paused: boolean; queueDepth: number }> = {}) => ({
		name,
		connection: "CONNECTED" as const,
		paused: false,
		queueDepth: 0,
		...overrides,
	});

	it("knows nothing until an agent reports", () => {
		expect(getDeviceStatus(agent, "kitchen")).toBeUndefined();
		expect(getAgentStatus(agent).size).toBe(0);
	});

	it("records what an agent reported", () => {
		recordStatus(agent, [report("kitchen", { queueDepth: 3 })]);

		const status = getDeviceStatus(agent, "kitchen");
		expect(status?.connection).toBe("CONNECTED");
		expect(status?.queueDepth).toBe(3);
		expect(status?.reportedAt).toBeInstanceOf(Date);
	});

	it("replaces the previous report rather than merging into it", () => {
		recordStatus(agent, [report("kitchen"), report("bar")]);

		recordStatus(agent, [report("kitchen")]);

		// Merging would leave a deleted device showing its last known state forever.
		expect(getDeviceStatus(agent, "bar")).toBeUndefined();
		expect(getDeviceStatus(agent, "kitchen")).toBeDefined();
	});

	it("keeps agents separate", () => {
		recordStatus(agent, [report("kitchen")]);
		recordStatus("other", [report("kitchen", { paused: true })]);

		expect(getDeviceStatus(agent, "kitchen")?.paused).toBe(false);
		expect(getDeviceStatus("other", "kitchen")?.paused).toBe(true);
	});

	it("forgets everything when an agent disconnects", () => {
		recordStatus(agent, [report("kitchen")]);

		clearAgentStatus(agent);

		// Its printers are unreachable the moment the socket is; the last report is no longer
		// evidence of anything.
		expect(getDeviceStatus(agent, "kitchen")).toBeUndefined();
	});

	it("accepts an empty report from an agent with no devices", () => {
		recordStatus(agent, [report("kitchen")]);

		recordStatus(agent, []);

		expect(getAgentStatus(agent).size).toBe(0);
	});

	it("returns an empty map for an agent that has never reported", () => {
		expect(getAgentStatus("never-seen").size).toBe(0);
	});
});
