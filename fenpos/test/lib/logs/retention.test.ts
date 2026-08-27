import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

		const { removed } = await sweepLogsNow(30, { archiveEnabled: false, archiveDirectory: "" });

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

		const { removed } = await sweepLogsNow(30, { archiveEnabled: false, archiveDirectory: "" });

		expect(removed).toBe(500);
		expect(vacuumSpy).toHaveBeenCalledExactlyOnceWith("VACUUM");

		vacuumSpy.mockClear();

		// Nothing left old enough to remove, so a second sweep must not vacuum again.
		const second = await sweepLogsNow(30, { archiveEnabled: false, archiveDirectory: "" });

		expect(second.removed).toBe(0);
		expect(vacuumSpy).not.toHaveBeenCalled();
	});

	it("archives a fully aged-out period instead of destroying it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fenpos-logs-sweep-"));
		try {
			await logsDb.logEntry.createMany({
				data: [
					{ level: "INFO", severity: 1, message: "january", ts: new Date("2026-01-15T00:00:00Z") },
					{ level: "INFO", severity: 1, message: "march", ts: new Date("2026-03-10T00:00:00Z") },
				],
			});
			vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-20T00:00:00Z") });

			const { removed } = await sweepLogsNow(30, { archiveEnabled: true, archiveDirectory: directory });

			expect(removed).toBe(1);
			expect(existsSync(join(directory, "logs-2026-01.db.gz"))).toBe(true);
			// Goes red if the sweep deletes by cutoff rather than by period: March is inside the cutoff's
			// own period and must survive whatever its individual timestamps say.
			expect(await logsDb.logEntry.findFirst({ where: { message: "march" } })).not.toBeNull();
		} finally {
			vi.useRealTimers();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("deletes by the strict window when archiving is off", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fenpos-logs-sweep-"));
		try {
			await logsDb.logEntry.createMany({
				data: [
					{ level: "INFO", severity: 1, message: "ancient", ts: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
					{ level: "INFO", severity: 1, message: "recent", ts: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
				],
			});

			const { removed } = await sweepLogsNow(30, { archiveEnabled: false, archiveDirectory: directory });

			expect(removed).toBe(1);
			expect(await logsDb.logEntry.findFirst({ where: { message: "ancient" } })).toBeNull();
			// Goes red if the off path silently rounds to periods: nothing should be written here at all.
			expect(readdirSync(directory)).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
