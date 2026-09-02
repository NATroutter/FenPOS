import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { publishMetricsFlush, startDeliveryDrain, startMaintenance } from "@/instrumentation-runtime";
import { auditDb, logsDb, metricsDb } from "@/lib/db";
import { AUDIT_ARCHIVE_DIRECTORY } from "@/lib/env";
import { publishHttpServer } from "@/lib/link/server-handle";
import { logger } from "@/lib/logger";
import { flushMetricCounters, recordApiMetric } from "@/lib/metrics/counters";

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
 * Waits on the real clock for a condition, giving up quietly when it never arrives.
 *
 * Quietly, so the assertion that follows is what reports the failure: a helper that threw here would
 * red a test on its own stack rather than on the expectation the test was written to make.
 *
 * Written out rather than reached for through `vi.waitFor`, because the tests below fake
 * `setInterval` — the one timer `startMaintenance` uses — and leave `setTimeout` real precisely so
 * there is still a way to wait for something.
 */
async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Lets the real clock run far enough that a wrongly-started second pass would have been observed. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 100));
}

/** What a test can see of the passes it started, and the one lever it has over them. */
interface PassWatcher {
	/** How many passes have entered the log half. */
	entered: () => number;
	/** Whether a pass has reached the audit half, which is the last thing it does. */
	swept: () => boolean;
	/** Lets the held pass out of the log half. */
	release: () => void;
	/** What the held pass is parked on, so a test can await the continuation it releases. */
	held: Promise<unknown>;
}

/**
 * The interval that owns retention.
 *
 * Archiving a period opens a database, copies it, verifies it and gzips it, and none of that is
 * quick. Two properties make an hourly timer safe to point at work like that: a pass that is still
 * running when the next tick arrives skips that tick rather than stacking, and the first pass does
 * not wait an hour — an install restarted more often than the interval would otherwise never sweep.
 */
describe("startMaintenance", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		rmSync(dirname(AUDIT_ARCHIVE_DIRECTORY), { recursive: true, force: true });
	});

	/**
	 * Counts passes as they enter, and lets a test decide when the one in flight may finish.
	 *
	 * Injected at the Prisma client rather than at `sweepLogsNow`, which is a named ESM export and
	 * cannot be spied. `logsDb.logEntry.findFirst` is the log half's first query with archiving on,
	 * which is `logs.archiveEnabled`'s built-in value; `auditDb.auditEvent.findFirst` is the audit
	 * half's, stubbed empty so a pass that gets past the gate has nothing left to do and finishes
	 * inside the test rather than after it.
	 */
	function watchPasses(): PassWatcher {
		let entered = 0;
		let swept = false;
		let release = (): void => undefined;
		const held = new Promise((resolve) => {
			release = (): void => resolve(null);
		});

		vi.spyOn(logsDb.logEntry, "findFirst").mockImplementation((() => {
			entered++;
			return held;
		}) as unknown as typeof logsDb.logEntry.findFirst);
		vi.spyOn(auditDb.auditEvent, "findFirst").mockImplementation((() => {
			swept = true;
			return Promise.resolve(null);
		}) as unknown as typeof auditDb.auditEvent.findFirst);
		vi.spyOn(logger, "error").mockImplementation(() => undefined);

		return { entered: () => entered, swept: () => swept, release, held };
	}

	/**
	 * Lets the held pass run to completion inside the test.
	 *
	 * `startMaintenance` returns nothing to await, so the pass it started would otherwise resume after
	 * the test body returns — while `afterEach` restores the mocks it is still using and `afterAll`
	 * removes the directory it provisioned. Waiting on the promise the log half is parked on, and then
	 * on the audit half having been reached, keeps that continuation inside the test.
	 */
	async function finish(watcher: PassWatcher): Promise<void> {
		watcher.release();
		await watcher.held;
		await until(watcher.swept);
	}

	it("runs a pass at startup rather than leaving the first hour unswept", async () => {
		const watcher = watchPasses();
		// Faked but never advanced, so the only thing that can enter a pass in this test is the call
		// `startMaintenance` makes before it ever schedules one.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

		startMaintenance();
		await until(() => watcher.entered() === 1);

		// Goes red if the startup pass is dropped in favour of the bare `setInterval` the plan's Step 4
		// showed: the first sweep would then land an hour after boot, and an install that restarts more
		// often than that — which `restart: unless-stopped` makes ordinary — would never sweep at all.
		expect(watcher.entered()).toBe(1);

		await finish(watcher);
	});

	it("skips a tick that arrives while a pass is still running", async () => {
		const watcher = watchPasses();
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

		startMaintenance();
		// The startup pass, parked inside `sweepLogsNow` and still holding the flag when the hour below
		// elapses.
		await until(() => watcher.entered() === 1);

		await vi.advanceTimersByTimeAsync(HOUR_MS);
		await settle();

		// Goes red if the `running` flag is dropped: the tick would enter a pass while the first is
		// still inside `sweepLogsNow`, which for real work means two rotations racing over one period's
		// archive file.
		expect(watcher.entered()).toBe(1);

		await finish(watcher);
	});

	it("does not hold the process open", async () => {
		const watcher = watchPasses();
		// Real timers deliberately. Under `vi.useFakeTimers` the returned object is the fake
		// scheduler's, and its `hasRef` answers for that scheduler rather than for the process this
		// interval could keep alive — which is the only thing worth asserting here.
		const created = vi.spyOn(globalThis, "setInterval");

		startMaintenance();

		// Read before awaiting anything, so no continuation of the startup pass can have scheduled an
		// interval of its own between the call and this line.
		const timer = created.mock.results[created.mock.results.length - 1].value as NodeJS.Timeout;
		try {
			// Goes red if `timer.unref()` is dropped: an hourly interval that keeps its reference is the
			// thing holding a container alive for up to an hour after it was asked to stop.
			expect(timer.hasRef()).toBe(false);
		} finally {
			// Mandatory rather than tidy: under the mutation above this timer *is* referenced, and
			// leaving it would hold the worker open for the hour it was scheduled for.
			clearInterval(timer);
		}

		await finish(watcher);
	});
});

/**
 * The other interval this module starts, and the older of the two.
 *
 * Only its reference is pinned here. Everything else about the drain — the skip-while-running flag, the
 * guard around `deliverDue` — belongs to `lib/webhooks/deliver.ts` and is covered there; what is only
 * true of this module is that the timer it creates must not be able to keep a container alive.
 */
describe("startDeliveryDrain", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not hold the process open", () => {
		// Real timers deliberately, for the reason the maintenance case above gives: under
		// `vi.useFakeTimers` the returned object is the fake scheduler's and its `hasRef` answers for
		// that scheduler rather than for the process. Nothing is awaited, so the five-second tick cannot
		// arrive and `deliverDue` is never called.
		const created = vi.spyOn(globalThis, "setInterval");

		startDeliveryDrain();

		const timer = created.mock.results[created.mock.results.length - 1].value as NodeJS.Timeout;
		try {
			// Goes red if `timer.unref()` is dropped: a five-second interval that keeps its reference holds
			// the process open indefinitely, which on a container asked to stop is a hang rather than a
			// delay.
			expect(timer.hasRef()).toBe(false);
		} finally {
			// Mandatory rather than tidy: under the mutation above this timer *is* referenced, and leaving
			// it would keep the worker alive and calling `deliverDue` every five seconds.
			clearInterval(timer);
		}
	});
});

/**
 * The graceful-shutdown flush hook, published on the HTTP server the same way `attachLink` above
 * publishes `fenposCloseLinks`. `server.ts` is the actual caller during a real shutdown, but it binds a
 * real port as a side effect of import and so is not something this suite can exercise directly — this
 * covers the half of the wiring that lives on this side of the handoff: the hook lands on the server
 * object, and calling it drains whatever counters were pending.
 */
describe("publishMetricsFlush", () => {
	afterEach(async () => {
		delete (globalThis as { __fenposHttpServer?: unknown }).__fenposHttpServer;
		await metricsDb.metricApiHourly.deleteMany();
		await flushMetricCounters();
		await metricsDb.metricApiHourly.deleteMany();
	});

	it("publishes a hook on the server that flushes the live counters when called", async () => {
		const server = createServer();
		publishHttpServer(server);

		try {
			publishMetricsFlush();
			const hook = (server as Server & { fenposFlushMetrics?: () => Promise<void> }).fenposFlushMetrics;
			expect(hook).toBeDefined();

			recordApiMetric({ route: "api:GET /v1/jobs", status: 200, apiKeyId: "k1", durationMs: 5 });
			// Goes red if the published hook is not `flushMetricCounters` itself, or is a copy that no
			// longer drains the same in-memory maps `recordApiMetric` just wrote to.
			await hook?.();

			const rows = await metricsDb.metricApiHourly.findMany({ where: { route: "api:GET /v1/jobs" } });
			expect(rows).toHaveLength(1);
			expect(rows[0].count).toBe(1);
		} finally {
			server.close();
		}
	});

	it("publishes nothing when no HTTP server has been published", () => {
		// The `next start` case `attachLink` already logs about; this hook must fail the same way —
		// quietly — rather than throwing when there is no server to attach to.
		expect(() => publishMetricsFlush()).not.toThrow();
	});
});
