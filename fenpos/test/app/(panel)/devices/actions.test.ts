import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VariableDefinition } from "@/lib/variables/definition";

vi.mock("@/lib/auth/require-session", () => ({ requireSession: vi.fn(async () => ({ id: "session" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { saveDeviceOverride } = await import("@/app/(panel)/devices/actions");
const { prisma } = await import("@/lib/db");
const { createVariable, listDeviceOverrides } = await import("@/lib/variables/variable-service");

/** A `STATIC` variable, the only kind `setDeviceOverride` will accept an override against. */
const staticVariable = (over: Partial<VariableDefinition> = {}): VariableDefinition => ({
	name: "phone",
	kind: "STATIC",
	value: "010-1234567",
	pattern: null,
	offsetAmount: null,
	offsetUnit: null,
	source: null,
	overridable: false,
	description: null,
	...over,
});

/** A `DATETIME` variable, which `setDeviceOverride` refuses — a format is the same on every printer. */
const datetimeVariable = (over: Partial<VariableDefinition> = {}): VariableDefinition => ({
	name: "printed-at",
	kind: "DATETIME",
	value: null,
	pattern: "HH:mm",
	offsetAmount: null,
	offsetUnit: null,
	source: null,
	overridable: false,
	description: null,
	...over,
});

/** Creates an agent and a device to hang overrides on, the same way `variable-service.test.ts` does. */
async function aDevice(): Promise<string> {
	const agent = await prisma.agent.create({ data: { name: `agent-${Date.now()}` } });
	const device = await prisma.device.create({ data: { agentId: agent.id, name: "counter", port: "COM1" } });
	return device.id;
}

describe("device variable overrides", () => {
	let deviceId: string;

	beforeEach(async () => {
		await prisma.deviceVariable.deleteMany();
		await prisma.variable.deleteMany();
		await prisma.device.deleteMany();
		await prisma.agent.deleteMany();
		deviceId = await aDevice();
	});

	it("sets a printer's own value", async () => {
		const variable = await createVariable(staticVariable());

		const state = await saveDeviceOverride(deviceId, variable.id, "this-printer");

		expect(state.error).toBeNull();
		expect(await listDeviceOverrides(deviceId)).toEqual(new Map([["phone", "this-printer"]]));
	});

	it("clears one when given an empty value", async () => {
		const variable = await createVariable(staticVariable());
		await saveDeviceOverride(deviceId, variable.id, "x");

		const state = await saveDeviceOverride(deviceId, variable.id, null);

		expect(state.error).toBeNull();
		expect(await listDeviceOverrides(deviceId)).toEqual(new Map());
	});

	it("reports a refusal on a non-static variable as a message", async () => {
		const variable = await createVariable(datetimeVariable());

		const state = await saveDeviceOverride(deviceId, variable.id, "x");

		expect(state.error).toBeTruthy();
	});
});
