import { beforeEach, describe, expect, it } from "vitest";
import { createAgent, listAgents, unpairAgent } from "@/lib/agents/agent-service";
import { redeemPairingCode } from "@/lib/agents/pairing";
import { prisma } from "@/lib/db";

/**
 * Unpairing as the panel experiences it.
 *
 * The failure this guards against was invisible in the service's own terms — the token was
 * cleared, the row said PENDING, every call succeeded — and only showed on the card: no code to
 * type, the same unpair button, an agent that read as merely offline. So what is asserted here is
 * what the card is built from, `listAgents`, and not only the row.
 */
describe("unpairAgent", () => {
	beforeEach(async () => {
		await prisma.pairingCode.deleteMany({});
		await prisma.agent.deleteMany({});
	});

	/** Creates an agent and pairs it, the way a real one would: by redeeming its code. */
	async function pairedAgent(name = "kitchen"): Promise<string> {
		const created = await createAgent(name);
		const result = await redeemPairingCode(created.code, {});
		if (!result.ok) {
			throw new Error(`pairing failed: ${result.failure}`);
		}
		return created.id;
	}

	it("revokes the credential and issues a fresh pairing code in the same step", async () => {
		const id = await pairedAgent();
		const before = await listAgents();
		expect(before[0]).toMatchObject({ paired: true, pairing: null });

		const issued = await unpairAgent(id);

		const [after] = await listAgents();
		expect(after.paired).toBe(false);
		expect(after.status).toBe("PENDING");
		expect(after.pairing?.code).toBe(issued.code);

		const stored = await prisma.agent.findUniqueOrThrow({ where: { id } });
		expect(stored.tokenHash).toBeNull();
	});

	it("does not carry the previous code over", async () => {
		const created = await createAgent("bar");
		const first = created.code;
		await redeemPairingCode(first, {});

		const second = await unpairAgent(created.id);

		expect(second.code).not.toBe(first);
		expect(await prisma.pairingCode.count({ where: { agentId: created.id, consumedAt: null } })).toBe(1);
	});

	it("lets the new code pair a replacement machine", async () => {
		const id = await pairedAgent();
		const { code } = await unpairAgent(id);

		const result = await redeemPairingCode(code, {});

		expect(result.ok).toBe(true);
		expect((await listAgents())[0].paired).toBe(true);
	});

	it("reports an unpaired agent as awaiting pairing even once its code has lapsed", async () => {
		const id = await pairedAgent();
		await unpairAgent(id);
		await prisma.pairingCode.deleteMany({ where: { agentId: id } });

		const [agent] = await listAgents();

		expect(agent.paired).toBe(false);
		expect(agent.pairing).toBeNull();
	});

	it("refuses an unknown agent", async () => {
		await expect(unpairAgent("no-such-agent")).rejects.toThrow(/no such agent/i);
	});

	it("fails the jobs an unpaired agent was still working on", async () => {
		// Clearing the credential means the agent will never report on these. Left alone they
		// would sit queued for ever, with no agent left that could ever settle them.
		const agent = await prisma.agent.create({ data: { name: "kitchen", tokenHash: "hash" }, select: { id: true } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "printer", port: "COM1" },
			select: { id: true },
		});
		const queued = await prisma.job.create({
			data: { agentId: agent.id, deviceId: device.id, status: "QUEUED" },
			select: { id: true },
		});
		const done = await prisma.job.create({
			data: { agentId: agent.id, deviceId: device.id, status: "COMPLETED" },
			select: { id: true },
		});

		await unpairAgent(agent.id);

		expect((await prisma.job.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("FAILED");
		expect((await prisma.job.findUniqueOrThrow({ where: { id: queued.id } })).errorCode).toBe("agent_unpaired");
		// A settled job stays settled: how a receipt ended is answered once.
		expect((await prisma.job.findUniqueOrThrow({ where: { id: done.id } })).status).toBe("COMPLETED");
	});
});
