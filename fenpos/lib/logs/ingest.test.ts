import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { clearLogWindow, ingestLog } from "@/lib/logs/ingest";
import { listLogs } from "@/lib/logs/log-service";
import { setSetting } from "@/lib/settings/settings-service";

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
		await prisma.setting.deleteMany();

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

	// -----------------------------------------------------------------------
	// Configured via settings
	// -----------------------------------------------------------------------

	/**
	 * The throttle, retention and truncation limits above are all configurable via the `logs.*`
	 * settings — these tests confirm a stored value actually reaches this path, not merely that it
	 * is stored (which `settings-service.test.ts` already covers).
	 *
	 * Settings are read once per rate-limit window rather than once per line (`ingest.ts`,
	 * `refreshLogIngestSettings`), which this file's `beforeEach` cooperates with: it creates a
	 * fresh agent id and calls `clearLogWindow` for it every test, so the first `ingestLog` call in
	 * each test always finds no window and refreshes the cached settings before checking anything
	 * against them.
	 */
	describe("configured via settings", () => {
		it("throttles at the configured rate rather than the built-in one", async () => {
			// 10 is logs.linesPerMinutePerAgent's declared minimum.
			await setSetting("logs.linesPerMinutePerAgent", 10);

			let accepted = 0;
			for (let attempt = 0; attempt < 15; attempt++) {
				if (await ingestLog(agentId, line({ message: `message ${attempt}` }))) {
					accepted++;
				}
			}

			// Ten through, then the throttle. With the built-in 120 all fifteen would land.
			expect(accepted).toBe(10);
		});

		it("truncates a message at the configured length rather than the built-in one", async () => {
			// 200 is logs.maxMessageChars's declared minimum.
			await setSetting("logs.maxMessageChars", 200);

			await ingestLog(agentId, line({ message: "a".repeat(500) }));

			expect((await listLogs()).lines[0].message).toHaveLength(200);
		});

		it("sweeps down to the configured row cap through the real ingest path, rather than the built-in one", async () => {
			// ingest.ts's own write counter (fenposLogWrites) is shared across every test in this
			// file and persists between them. Reset it so logs.sweepEvery's gate — left at its
			// built-in 500 in this test — trips at a known point in this test's own loop below,
			// rather than at whatever offset earlier tests happened to leave it.
			(globalThis as unknown as { fenposLogWrites: number | undefined }).fenposLogWrites = 0;

			// High enough that the throttle — not what this test is exercising — never engages
			// across the real calls below.
			await setSetting("logs.linesPerMinutePerAgent", 600);
			// 1000 is logs.maxRecords's declared minimum.
			await setSetting("logs.maxRecords", 1000);

			// The backlog is seeded directly, so building it up past the cap stays one bulk query.
			// Only the writes that need to be real — enough to cross logs.sweepEvery's built-in 500
			// and trigger sweepOccasionally for real, through ingestLog itself rather than by calling
			// the sweep entry point directly — go through the throttled, awaited ingestLog path below.
			await prisma.logEntry.createMany({
				data: Array.from({ length: 1000 }, (_, index) => ({
					level: "INFO",
					severity: 1,
					message: `backlog ${index}`,
					agentId,
					ts: new Date(Date.now() + index),
				})),
			});

			for (let attempt = 0; attempt < 500; attempt++) {
				await ingestLog(
					agentId,
					line({ message: `message ${attempt}`, at: new Date(Date.now() + 1000 + attempt).toISOString() }),
				);
			}

			// The counter reset to 0 above and exactly 500 accepted writes below land the counter
			// on exactly the built-in logs.sweepEvery, so sweepOccasionally's real gate fires once,
			// on the last of these calls — via ingestLog -> sweepOccasionally(maxRows, sweepEvery) ->
			// sweepLogsNow. That call is fire-and-forget (ingestLog does not await it), so the
			// deletion this proves may still be in flight the instant the loop above returns; wait
			// for it rather than asserting immediately.
			await vi.waitFor(async () => {
				expect(await prisma.logEntry.count()).toBeLessThanOrEqual(1000);
			});
		});

		/**
		 * The counterpart of the test above: a lower `logs.sweepEvery` makes the sweep trip after
		 * far fewer writes than the built-in 500, proving the gate itself is configured rather than
		 * only the row cap it sweeps down to.
		 */
		it("sweeps at the configured interval rather than the built-in one", async () => {
			(globalThis as unknown as { fenposLogWrites: number | undefined }).fenposLogWrites = 0;

			// High enough that the throttle never engages across the real calls below.
			await setSetting("logs.linesPerMinutePerAgent", 600);
			// 1000 is logs.maxRecords's declared minimum.
			await setSetting("logs.maxRecords", 1000);
			// 50 is logs.sweepEvery's declared minimum — a tenth of the built-in 500, so the sweep
			// fires after 50 real writes rather than needing ten times as many.
			await setSetting("logs.sweepEvery", 50);

			await prisma.logEntry.createMany({
				data: Array.from({ length: 1000 }, (_, index) => ({
					level: "INFO",
					severity: 1,
					message: `backlog ${index}`,
					agentId,
					ts: new Date(Date.now() + index),
				})),
			});

			for (let attempt = 0; attempt < 50; attempt++) {
				await ingestLog(
					agentId,
					line({ message: `message ${attempt}`, at: new Date(Date.now() + 1000 + attempt).toISOString() }),
				);
			}

			// The counter reset to 0 above and exactly 50 accepted writes below land it on exactly
			// the configured sweepEvery, so the real gate fires once, on the last of these calls —
			// which the built-in 500 would not have reached with only 50 writes.
			await vi.waitFor(async () => {
				expect(await prisma.logEntry.count()).toBeLessThanOrEqual(1000);
			});
		});
	});
});
