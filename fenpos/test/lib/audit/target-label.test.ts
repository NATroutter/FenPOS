import { beforeEach, describe, expect, it } from "vitest";
import { describeTarget } from "@/lib/audit/target-label";
import { prisma } from "@/lib/db";

/**
 * The name beside the id in the audit record.
 *
 * What is asserted is what the Target column shows: for each kind an action names by id, the label
 * the panel would show for the same thing — and that a caller's own label, a kind nobody resolves, and
 * an id that matches nothing all leave the target exactly as the action gave it.
 */
describe("describeTarget", () => {
	beforeEach(async () => {
		await prisma.job.deleteMany({});
		await prisma.device.deleteMany({});
		await prisma.agent.deleteMany({});
		await prisma.apiKey.deleteMany({});
		await prisma.variable.deleteMany({});
		await prisma.role.deleteMany({});
	});

	it("names an agent, a device by its agent, and a job by its printer and short id", async () => {
		const agent = await prisma.agent.create({ data: { name: "home" }, select: { id: true } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "desk", port: "COM1" },
			select: { id: true },
		});
		const job = await prisma.job.create({
			data: { agentId: agent.id, deviceId: device.id, status: "QUEUED" },
			select: { id: true },
		});

		expect(await describeTarget({ kind: "agent", id: agent.id })).toEqual({
			kind: "agent",
			id: agent.id,
			label: "home",
		});
		expect(await describeTarget({ kind: "device", id: device.id })).toEqual({
			kind: "device",
			id: device.id,
			label: "home/desk",
		});
		expect(await describeTarget({ kind: "job", id: job.id })).toEqual({
			kind: "job",
			id: job.id,
			label: `home/desk · ${job.id.slice(-8)}`,
		});
	});

	it("names a role, an API key and a variable", async () => {
		const role = await prisma.role.create({ data: { name: "Watcher" }, select: { id: true } });
		const key = await prisma.apiKey.create({
			data: { name: "Till 4", keyHash: "hash-till-4", maskedHint: "ll 4" },
			select: { id: true },
		});
		const variable = await prisma.variable.create({
			data: { name: "phone", kind: "STATIC", value: "123" },
			select: { id: true },
		});

		expect((await describeTarget({ kind: "role", id: role.id }))?.label).toBe("Watcher");
		expect((await describeTarget({ kind: "api-key", id: key.id }))?.label).toBe("Till 4");
		expect((await describeTarget({ kind: "variable", id: variable.id }))?.label).toBe("phone");
	});

	it("keeps a label the action gave, even when the database would say otherwise", async () => {
		const agent = await prisma.agent.create({ data: { name: "home" }, select: { id: true } });

		// A rename records the new name; looking the old one up would record the wrong thing.
		expect(await describeTarget({ kind: "agent", id: agent.id, label: "kitchen" })).toEqual({
			kind: "agent",
			id: agent.id,
			label: "kitchen",
		});
	});

	it("leaves an unknown kind, a missing id and a stale id untouched", async () => {
		expect(await describeTarget({ kind: "page", id: "/agents" })).toEqual({ kind: "page", id: "/agents" });
		expect(await describeTarget({ kind: "agent" })).toEqual({ kind: "agent" });
		expect(await describeTarget({ kind: "agent", id: "no-such-agent" })).toEqual({
			kind: "agent",
			id: "no-such-agent",
		});
		expect(await describeTarget(undefined)).toBeUndefined();
	});
});
