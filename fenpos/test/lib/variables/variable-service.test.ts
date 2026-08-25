import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import type { VariableDefinition } from "@/lib/variables/definition";
import {
	createVariable,
	deleteVariable,
	listDeviceOverrides,
	listVariables,
	setDeviceOverride,
	updateVariable,
} from "@/lib/variables/variable-service";

const definition = (over: Partial<VariableDefinition> = {}): VariableDefinition => ({
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

/** Creates an agent and a device to hang overrides on. */
async function aDevice(): Promise<string> {
	const agent = await prisma.agent.create({ data: { name: `agent-${Date.now()}` } });
	const device = await prisma.device.create({ data: { agentId: agent.id, name: "counter", port: "COM1" } });
	return device.id;
}

describe("variable service", () => {
	beforeEach(async () => {
		await prisma.deviceVariable.deleteMany();
		await prisma.variable.deleteMany();
		await prisma.device.deleteMany();
		await prisma.agent.deleteMany();
	});

	it("stores and lists a variable", async () => {
		await createVariable(definition());

		const stored = await listVariables();
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ name: "phone", kind: "STATIC", value: "010-1234567", overridable: false });
	});

	it("lists variables by name, so the panel's order does not depend on insertion", async () => {
		await createVariable(definition({ name: "website", value: "fenpos.fi" }));
		await createVariable(definition({ name: "phone" }));

		expect((await listVariables()).map((one) => one.name)).toEqual(["phone", "website"]);
	});

	it("refuses a second variable with the same name", async () => {
		await createVariable(definition());

		await expect(createVariable(definition({ value: "other" }))).rejects.toBeInstanceOf(ApiError);
	});

	it("refuses a definition its schema rejects", async () => {
		await expect(createVariable(definition({ kind: "DATETIME" }))).rejects.toBeInstanceOf(ApiError);
	});

	it("refuses a value longer than the configured cap", async () => {
		await expect(createVariable(definition({ value: "x".repeat(201) }))).rejects.toBeInstanceOf(ApiError);
	});

	it("refuses a value containing a control character", async () => {
		await expect(createVariable(definition({ value: `x${String.fromCharCode(0x1b)}y` }))).rejects.toBeInstanceOf(
			ApiError,
		);
	});

	it("updates a variable in place", async () => {
		const created = await createVariable(definition());

		await updateVariable(created.id, definition({ value: "020-7654321", overridable: true }));

		const stored = await listVariables();
		expect(stored[0]).toMatchObject({ value: "020-7654321", overridable: true });
	});

	it("clears the fields of the kind a variable no longer is", async () => {
		const created = await createVariable(definition());

		await updateVariable(created.id, definition({ kind: "DATETIME", value: null, pattern: "HH:mm" }));

		const stored = (await listVariables())[0];
		expect(stored.value).toBeNull();
		expect(stored.pattern).toBe("HH:mm");
	});

	it("deletes a variable", async () => {
		const created = await createVariable(definition());

		await deleteVariable(created.id);

		expect(await listVariables()).toHaveLength(0);
	});

	describe("device overrides", () => {
		it("stores and reads one", async () => {
			const deviceId = await aDevice();
			const created = await createVariable(definition());

			await setDeviceOverride(deviceId, created.id, "030-0000000");

			expect(await listDeviceOverrides(deviceId)).toEqual(new Map([["phone", "030-0000000"]]));
		});

		it("replaces an existing one rather than failing", async () => {
			const deviceId = await aDevice();
			const created = await createVariable(definition());

			await setDeviceOverride(deviceId, created.id, "first");
			await setDeviceOverride(deviceId, created.id, "second");

			expect(await listDeviceOverrides(deviceId)).toEqual(new Map([["phone", "second"]]));
		});

		it("clears one when given null", async () => {
			const deviceId = await aDevice();
			const created = await createVariable(definition());
			await setDeviceOverride(deviceId, created.id, "x");

			await setDeviceOverride(deviceId, created.id, null);

			expect(await listDeviceOverrides(deviceId)).toEqual(new Map());
		});

		it("refuses an override on a variable that is not static", async () => {
			const deviceId = await aDevice();
			const created = await createVariable(definition({ kind: "DATETIME", value: null, pattern: "HH:mm" }));

			await expect(setDeviceOverride(deviceId, created.id, "x")).rejects.toBeInstanceOf(ApiError);
		});

		it("goes away with the variable it overrides", async () => {
			const deviceId = await aDevice();
			const created = await createVariable(definition());
			await setDeviceOverride(deviceId, created.id, "x");

			await deleteVariable(created.id);

			expect(await listDeviceOverrides(deviceId)).toEqual(new Map());
		});
	});
});
