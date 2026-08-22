import { describe, expect, it } from "vitest";
import { deviceView } from "@/lib/api/device-view";
import type { GrantedDevice } from "@/lib/keys/authenticate";

/**
 * The shape one device takes in every API response that mentions one.
 *
 * The test that matters here is the one about an agent that has reported nothing: the observed
 * block must be null rather than a zero-filled object. "Disconnected with an empty queue" and "we
 * have not heard from this agent" are different facts, and a caller deciding whether to print needs
 * to tell them apart.
 */

const DEVICE: GrantedDevice = {
	id: "dev-1",
	name: "kitchen",
	agentId: "agent-1",
	agentName: "helsinki",
	port: "COM3",
	columns: 42,
	codepage: "CP858",
	defaultLinefeed: "LF",
	paused: false,
	maxQueueDepth: 100,
};

describe("deviceView", () => {
	it("reports the configuration a caller needs to compose markup", () => {
		const view = deviceView(DEVICE, undefined);

		expect(view.agent).toBe("helsinki");
		expect(view.device).toBe("kitchen");
		expect(view.columns).toBe(42);
		expect(view.codepage).toBe("CP858");
	});

	it("reports null observed state when the agent has said nothing", () => {
		expect(deviceView(DEVICE, undefined).observed).toBeNull();
	});

	it("reports what the agent last said, with the moment it said it", () => {
		const reportedAt = new Date("2026-08-22T10:00:00.000Z");
		const view = deviceView(DEVICE, {
			connection: "CONNECTED",
			paused: false,
			queueDepth: 3,
			reportedAt,
		});

		expect(view.observed).toEqual({
			connection: "CONNECTED",
			queueDepth: 3,
			reportedAt: "2026-08-22T10:00:00.000Z",
		});
	});

	it("reports the configured pause state, not the reported one", () => {
		// The column is desired state and survives an agent restart; the agent's copy is a cache of
		// it. Reporting the cache would show a printer as running for the seconds after a restart
		// during which it is not.
		const view = deviceView(
			{ ...DEVICE, paused: true },
			{
				connection: "CONNECTED",
				paused: false,
				queueDepth: 0,
				reportedAt: new Date(),
			},
		);

		expect(view.paused).toBe(true);
	});

	it("does not leak the internal device id", () => {
		// Callers address devices by agent and device name. An id in the body would become a second
		// addressing scheme integrators start depending on, and it is a cuid an install did not
		// choose to publish.
		expect(deviceView(DEVICE, undefined)).not.toHaveProperty("id");
	});
});
