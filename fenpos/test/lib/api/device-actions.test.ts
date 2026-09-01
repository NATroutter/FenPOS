import { describe, expect, it } from "vitest";
import { API_DEVICE_ACTIONS, apiActionSchema, commandFor, PERSISTS_PAUSE } from "@/lib/api/device-actions";
import { DEVICE_COMMANDS } from "@/lib/link/protocol";

/**
 * The public action names, checked against the wire commands they map onto.
 *
 * Two languages meet here. The API's names are short verbs an integrator types; the link's are
 * dotted frame types the agent switches on. Restating one in terms of the other is how they drift,
 * so every mapping is asserted against `DEVICE_COMMANDS` itself rather than against a copy.
 */

describe("device action mapping", () => {
	it("maps every public action onto a command the agent actually accepts", () => {
		for (const action of API_DEVICE_ACTIONS) {
			expect(DEVICE_COMMANDS).toContain(commandFor(action));
		}
	});

	it("does not expose the test print, which is a print and belongs behind 'jobs:submit'", () => {
		expect(API_DEVICE_ACTIONS).not.toContain("test");
		expect(apiActionSchema.safeParse("test").success).toBe(false);
	});

	it("accepts every declared action and refuses anything else", () => {
		for (const action of API_DEVICE_ACTIONS) {
			expect(apiActionSchema.safeParse(action).success).toBe(true);
		}
		expect(apiActionSchema.safeParse("explode").success).toBe(false);
		expect(apiActionSchema.safeParse("device.pause").success).toBe(false);
	});

	it("records which actions change desired state, so pause survives an agent restart", () => {
		expect(PERSISTS_PAUSE.pause).toBe(true);
		expect(PERSISTS_PAUSE.resume).toBe(false);
		expect(PERSISTS_PAUSE.connect).toBeUndefined();
		expect(PERSISTS_PAUSE.disconnect).toBeUndefined();
		expect(PERSISTS_PAUSE.clearQueue).toBeUndefined();
	});
});
