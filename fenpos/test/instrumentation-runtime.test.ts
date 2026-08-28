import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { startMaintenance } from "@/instrumentation-runtime";
import { logsDb } from "@/lib/db";
import { AUDIT_ARCHIVE_DIRECTORY } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Redirected for the same reason `test/lib/maintenance/pass.test.ts` redirects it: a pass started
 * here provisions the archive directory for real, and the real one is where a developer's own audit
 * archives live.
 */
vi.mock("@/lib/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/env")>();
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	return { ...actual, AUDIT_ARCHIVE_DIRECTORY: join(mkdtempSync(join(tmpdir(), "fenpos-runtime-")), "archives") };
});

/** An hour, matching `MAINTENANCE_INTERVAL_MS`. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * Waits for a condition using the real clock.
 *
 * Written out rather than reached for through `vi.waitFor`, because the tests below fake
 * `setInterval` — the one timer `startMaintenance` uses — and leave `setTimeout` real precisely so
 * there is still a way to wait for something.
 */
async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("until: the condition never became true");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Lets the real clock run far enough that a wrongly-started second pass would have been observed. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * The interval that owns retention.
 *
 * Archiving a period opens a database, copies it, verifies it and gzips it, and none of that is
 * quick. The property that makes an hourly timer safe to point at work like that is the one below: a
 * pass that is still running when the next tick arrives skips that tick instead of stacking a second
 * pass on top of the first.
 */
describe("startMaintenance", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		rmSync(dirname(AUDIT_ARCHIVE_DIRECTORY), { recursive: true, force: true });
	});

	it("skips a tick that arrives while a pass is still running", async () => {
		let entered = 0;
		let release = (): void => undefined;
		// Never settles until this test says so, which is what makes the first pass still be running
		// when the second tick arrives. The log half's first query with archiving on, injected at the
		// client because `sweepLogsNow` is a named ESM export and cannot be spied.
		const held = new Promise((resolve) => {
			release = (): void => resolve(null);
		});
		vi.spyOn(logsDb.logEntry, "findFirst").mockImplementation((() => {
			entered++;
			return held;
		}) as unknown as typeof logsDb.logEntry.findFirst);
		vi.spyOn(logger, "error").mockImplementation(() => undefined);

		// Only `setInterval`, so `setTimeout` stays real and `until` above still works.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

		startMaintenance();
		await vi.advanceTimersByTimeAsync(HOUR_MS);
		await until(() => entered === 1);

		await vi.advanceTimersByTimeAsync(HOUR_MS);
		await settle();

		// Goes red if the `running` flag is dropped: the second tick would enter a pass while the first
		// is still inside `sweepLogsNow`, which for real work means two rotations racing over one
		// period's archive file.
		expect(entered).toBe(1);

		release();
	});
});
