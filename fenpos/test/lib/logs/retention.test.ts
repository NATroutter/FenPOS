import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logsDb } from "@/lib/db";
import { sweepLogsNow } from "@/lib/logs/retention";

const DAY = 24 * 60 * 60 * 1000;

describe("log retention", () => {
	beforeEach(async () => {
		await logsDb.logEntry.deleteMany();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("removes by age and keeps everything inside the window, whatever the volume", async () => {
		await logsDb.logEntry.createMany({
			data: [
				{ level: "INFO", severity: 1, message: "ancient", ts: new Date(Date.now() - 40 * DAY) },
				{ level: "INFO", severity: 1, message: "recent", ts: new Date(Date.now() - 2 * DAY) },
			],
		});
		// Volume inside the window, which a row cap would have evicted and a time window must not.
		await logsDb.logEntry.createMany({
			data: Array.from({ length: 200 }, (_, index) => ({
				level: "INFO" as const,
				severity: 1,
				message: `burst ${index}`,
				ts: new Date(Date.now() - DAY),
			})),
		});

		const { removed } = await sweepLogsNow(30);

		expect(removed).toBe(1);
		expect(await logsDb.logEntry.findFirst({ where: { message: "ancient" } })).toBeNull();
		expect(await logsDb.logEntry.findFirst({ where: { message: "recent" } })).not.toBeNull();
		// The burst survives. Goes red the moment a count-based bound is reintroduced.
		expect(await logsDb.logEntry.count({ where: { message: { startsWith: "burst" } } })).toBe(200);
	});

	/**
	 * `VACUUM` is what actually returns freed pages to the filesystem — without it a burst that
	 * aged out would still leave the file at its inflated size. A test asserting the file shrinks
	 * would be fragile (SQLite's page reuse and OS-level file allocation make "smaller" an unreliable
	 * signal on every platform), so this instead pins the behaviour the code controls directly: a
	 * delete that actually removed rows is followed by a real `VACUUM` statement, and a delete that
	 * removed nothing is not — the exact condition `sweepLogsNow` branches on. Goes red if the
	 * `count > 0` guard is dropped in either direction, or if `VACUUM` stops being what runs.
	 */
	it("runs VACUUM after removing rows, but not when nothing was removed", async () => {
		await logsDb.logEntry.createMany({
			data: Array.from({ length: 500 }, (_, index) => ({
				level: "INFO" as const,
				severity: 1,
				message: `old ${index}`,
				ts: new Date(Date.now() - 40 * DAY),
			})),
		});
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "recent", ts: new Date(Date.now() - DAY) },
		});

		const vacuumSpy = vi.spyOn(logsDb, "$executeRawUnsafe");

		const { removed } = await sweepLogsNow(30);

		expect(removed).toBe(500);
		expect(vacuumSpy).toHaveBeenCalledExactlyOnceWith("VACUUM");

		vacuumSpy.mockClear();

		// Nothing left old enough to remove, so a second sweep must not vacuum again.
		const second = await sweepLogsNow(30);

		expect(second.removed).toBe(0);
		expect(vacuumSpy).not.toHaveBeenCalled();
	});
});
