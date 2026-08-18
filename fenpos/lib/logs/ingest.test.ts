import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { clearLogWindow, ingestLog } from "@/lib/logs/ingest";
import { listLogs } from "@/lib/logs/log-service";

/**
 * Tests for agent log ingestion.
 *
 * The case that matters is the flood. An agent stuck in a failure loop — a port that will not
 * open, a job retrying forever — produces the same line thousands of times a minute, and without
 * a bound it would fill the table with it and push out everything worth reading. The limit is per
 * agent, so one misbehaving site cannot drown out the others.
 */
describe("log ingestion", () => {
	let agentId: string;
	let otherAgentId: string;

	beforeEach(async () => {
		await prisma.logEntry.deleteMany();
		await prisma.device.deleteMany();
		await prisma.agent.deleteMany();

		agentId = (await prisma.agent.create({ data: { name: "site-a" }, select: { id: true } })).id;
		otherAgentId = (await prisma.agent.create({ data: { name: "site-b" }, select: { id: true } })).id;

		await prisma.device.create({ data: { agentId, name: "kitchen", port: "COM3" } });

		clearLogWindow(agentId);
		clearLogWindow(otherAgentId);
	});

	const line = (overrides: Partial<Parameters<typeof ingestLog>[1]> = {}) =>
		({
			type: "log" as const,
			level: "INFO" as const,
			message: "something happened",
			at: new Date().toISOString(),
			...overrides,
		}) as Parameters<typeof ingestLog>[1];

	it("records a line", async () => {
		expect(await ingestLog(agentId, line())).toBe(true);

		const { lines } = await listLogs();
		expect(lines).toHaveLength(1);
		expect(lines[0].message).toBe("something happened");
		expect(lines[0].agentName).toBe("site-a");
	});

	it("attributes a line to the device it names", async () => {
		await ingestLog(agentId, line({ device: "kitchen" }));

		expect((await listLogs()).lines[0].deviceName).toBe("kitchen");
	});

	it("records a line naming an unknown device against the agent alone", async () => {
		// A name that matches nothing is not an error: the device may have just been deleted.
		expect(await ingestLog(agentId, line({ device: "nowhere" }))).toBe(true);

		expect((await listLogs()).lines[0].deviceName).toBeNull();
	});

	it("cannot attribute a line to another agent's device", async () => {
		await ingestLog(otherAgentId, line({ device: "kitchen" }));

		// The lookup is scoped to the sending agent, so naming another's device attributes
		// nothing rather than the wrong thing.
		expect((await listLogs()).lines[0].deviceName).toBeNull();
	});

	it("truncates an over-long message rather than refusing it", async () => {
		await ingestLog(agentId, line({ message: "a".repeat(5000) }));

		expect((await listLogs()).lines[0].message.length).toBe(1000);
	});

	it("drops lines past the per-agent rate limit", async () => {
		let accepted = 0;
		for (let attempt = 0; attempt < 200; attempt++) {
			if (await ingestLog(agentId, line({ message: `line ${attempt}` }))) {
				accepted++;
			}
		}

		expect(accepted).toBe(120);
		expect((await prisma.logEntry.count()).valueOf()).toBe(120);
	});

	it("limits each agent separately", async () => {
		for (let attempt = 0; attempt < 200; attempt++) {
			await ingestLog(agentId, line());
		}

		// One site flooding must not silence another's lines.
		expect(await ingestLog(otherAgentId, line({ message: "still heard" }))).toBe(true);
	});

	it("starts a fresh allowance once an agent's window is cleared", async () => {
		for (let attempt = 0; attempt < 200; attempt++) {
			await ingestLog(agentId, line());
		}
		expect(await ingestLog(agentId, line())).toBe(false);

		// What a reconnect does: the agent that comes back is not still being punished for what
		// the previous connection did.
		clearLogWindow(agentId);

		expect(await ingestLog(agentId, line())).toBe(true);
	});

	it("keeps the agent's own timestamp", async () => {
		const at = new Date(Date.now() - 60_000).toISOString();

		await ingestLog(agentId, line({ at }));

		expect(new Date((await listLogs()).lines[0].at).toISOString()).toBe(at);
	});

	// -----------------------------------------------------------------------
	// Reading back
	// -----------------------------------------------------------------------

	it("returns lines newest first", async () => {
		await ingestLog(agentId, line({ message: "first", at: new Date(Date.now() - 2000).toISOString() }));
		await ingestLog(agentId, line({ message: "second", at: new Date().toISOString() }));

		expect((await listLogs()).lines.map((entry) => entry.message)).toEqual(["second", "first"]);
	});

	it("filters by severity and everything worse", async () => {
		await ingestLog(agentId, line({ level: "DEBUG", message: "noise" }));
		await ingestLog(agentId, line({ level: "WARN", message: "concerning" }));
		await ingestLog(agentId, line({ level: "ERROR", message: "broken" }));

		const { lines } = await listLogs({ level: "WARN" });

		// Someone looking for errors still wants the warning that preceded it, and nobody wants
		// to tick four boxes to see everything that went wrong.
		expect(lines.map((entry) => entry.message).sort()).toEqual(["broken", "concerning"]);
	});

	it("filters by agent", async () => {
		await ingestLog(agentId, line({ message: "from a" }));
		await ingestLog(otherAgentId, line({ message: "from b" }));

		expect((await listLogs({ agentId })).lines.map((entry) => entry.message)).toEqual(["from a"]);
	});

	it("reports whether more lines follow", async () => {
		for (let attempt = 0; attempt < 5; attempt++) {
			await ingestLog(agentId, line({ message: `line ${attempt}` }));
		}

		expect((await listLogs({ take: 2 })).more).toBe(true);
		expect((await listLogs({ take: 50 })).more).toBe(false);
	});
});
