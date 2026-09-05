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

	it("holds the cap across a reconnect", async () => {
		for (let index = 0; index < 25; index++) {
			await ingestLog(agentId, line(index));
		}
		const afterFirst = await logsDb.logEntry.count({ where: { agentId } });

		// Nothing about a socket closing gives an agent a fresh minute.
		for (let index = 100; index < 125; index++) {
			await ingestLog(agentId, line(index));
		}

		expect(await logsDb.logEntry.count({ where: { agentId } })).toBe(afterFirst);
	});
});
