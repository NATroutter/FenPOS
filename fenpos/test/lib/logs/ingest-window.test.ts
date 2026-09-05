import { beforeEach, describe, expect, it } from "vitest";
import { logsDb, prisma } from "@/lib/db";
import type { LogFrame } from "@/lib/link/protocol";
import { ingestLog } from "@/lib/logs/ingest";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * The cap on how much one agent may write is what keeps a site stuck in a failure loop from
 * filling this database with the same line and pushing out everything worth reading. It is stated
 * per minute, so it has to hold against a burst arriving together and across a reconnect —
 * neither of which an agent has to be hostile to produce.
 */
describe("agent log ingestion", () => {
	function line(index: number): LogFrame {
		return { type: "log", level: "WARN", message: `flood ${index}`, at: new Date().toISOString() };
	}

	let agentId: string;

	beforeEach(async () => {
		await logsDb.logEntry.deleteMany({});
		await prisma.agent.deleteMany({});
		await prisma.setting.deleteMany({});
		await setSetting("logs.linesPerMinutePerAgent", 10);
		agentId = (await prisma.agent.create({ data: { name: "kitchen" }, select: { id: true } })).id;
	});

	it("holds the cap against lines that arrive together", async () => {
		// Frames are handled without waiting for one another, so the window has to exist from the
		// first line rather than from whenever a settings read happens to finish.
		await Promise.all(Array.from({ length: 25 }, (_, index) => ingestLog(agentId, line(index))));

		expect(await logsDb.logEntry.count({ where: { agentId } })).toBeLessThanOrEqual(10);
	});

	it("honours the configured cap once the settings read has already landed", async () => {
		// 10 (this file's beforeEach) is also the declared minimum a cold cap falls back to, so a
		// burst decided against 10 cannot tell "the setting was honoured" apart from "the read
		// hadn't landed yet and the floor stood in for it." Raising the cap and warming the cache
		// with an awaited call before the burst rules that out. The warm-up has to run against a
		// different agent, since the cache is global but the window is per agent — running it
		// against the same agent the burst targets would leave that agent's window already open
		// (and its count already at one) rather than fresh for the burst to fill.
		await setSetting("logs.linesPerMinutePerAgent", 20);
		await ingestLog(agentId, line(0));

		const burstAgentId = (await prisma.agent.create({ data: { name: "counter" }, select: { id: true } })).id;
		await Promise.all(Array.from({ length: 25 }, (_, index) => ingestLog(burstAgentId, line(index))));

		const stored = await logsDb.logEntry.count({ where: { agentId: burstAgentId } });
		expect(stored).toBeLessThanOrEqual(20);
		expect(stored).toBeGreaterThan(10);
	});

	it("keeps counting once a window is already open", async () => {
		for (let index = 0; index < 25; index++) {
			await ingestLog(agentId, line(index));
		}
		const afterFirst = await logsDb.logEntry.count({ where: { agentId } });

		// A later batch inside the same still-open window adds to the count already there rather
		// than starting over, which is what makes the cap mean anything past the line that first
		// reached it.
		for (let index = 100; index < 125; index++) {
			await ingestLog(agentId, line(index));
		}

		expect(await logsDb.logEntry.count({ where: { agentId } })).toBe(afterFirst);
	});
});
