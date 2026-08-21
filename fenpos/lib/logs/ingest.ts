import "server-only";
import { prisma } from "@/lib/db";
import type { LogLevel } from "@/lib/domain/enums";
import { publish } from "@/lib/events/bus";
import type { LogFrame } from "@/lib/link/protocol";
import { logger } from "@/lib/logger";
import { LOG_SEVERITY } from "@/lib/logs/log-sort";
import { globalLogIngestSettings } from "@/lib/settings/settings-service";

/**
 * Recording log lines an agent forwarded.
 *
 * **The server does not trust an agent's volume.** A agent stuck in a failure loop — a port that
 * will not open, a job retrying forever — produces the same line thousands of times a minute, and
 * without a bound it would fill the database with it and push out everything worth reading. The
 * cap is per agent, so one misbehaving site cannot drown out the others.
 *
 * Retention is bounded the same way and for the same reason: this table exists to answer "what
 * happened this shift", not to be an archive.
 */

/**
 * How long a rate-limit window lasts.
 *
 * A constant, deliberately, even though the limit it enforces (`logs.linesPerMinutePerAgent`) is
 * now configurable: that setting is expressed *per minute*, so a fixed 60-second window is what
 * makes the configured number mean what its label promises. Letting the window drift too would
 * decouple the two — "200 lines per minute" enforced over some other window is not that.
 */
const WINDOW_MS = 60_000;

/** How often the sweep runs, measured in ingested lines rather than in time. */
const SWEEP_EVERY = 500;

interface Window {
	count: number;
	resetAt: number;
	/** Whether the agent has already been told it is being throttled, so it is said once. */
	warned: boolean;
}

/**
 * The `logs.*` settings this module reads, cached rather than read fresh for every ingested line.
 */
interface LogIngestSettings {
	/** `logs.linesPerMinutePerAgent`: lines one agent may record per window before the rest are dropped. */
	maxLinesPerWindow: number;
	/** `logs.maxMessageChars`: longest message stored. Anything beyond is truncated rather than rejected. */
	maxMessageChars: number;
	/** `logs.maxRecords`: rows kept before the oldest are swept. */
	maxRows: number;
}

const globalForIngest = globalThis as unknown as {
	fenposLogWindows: Map<string, Window> | undefined;
	fenposLogWrites: number | undefined;
	fenposLogIngestSettings: LogIngestSettings | undefined;
};

if (!globalForIngest.fenposLogWindows) {
	globalForIngest.fenposLogWindows = new Map();
}

const windows: Map<string, Window> = globalForIngest.fenposLogWindows;

/**
 * Re-reads the three `logs.*` settings from the database and caches them.
 *
 * `ingestLog` runs on the hot path for every line every agent sends, so reading these settings
 * there directly would be a database query per line. Instead this is called only from {@link allow}
 * when an agent's rate-limit window is (re)created — its first line, or its first line after 60
 * seconds of quiet — which happens at most once per agent per window rather than once per line.
 * The settings themselves change, at most, a few times a year, so the cost is a change made
 * mid-window reaching an already-connected agent up to one window late, in exchange for turning a
 * per-line query into roughly one per agent per minute.
 *
 * Reads all three as one {@link globalLogIngestSettings} call rather than one settings lookup
 * each — the same reason that function itself reads `listSettings()` once rather than per key.
 *
 * @returns the settings just read
 */
async function refreshLogIngestSettings(): Promise<LogIngestSettings> {
	const { linesPerMinutePerAgent, maxRecords, maxMessageChars } = await globalLogIngestSettings();

	const settings: LogIngestSettings = {
		maxLinesPerWindow: linesPerMinutePerAgent,
		maxMessageChars,
		maxRows: maxRecords,
	};
	globalForIngest.fenposLogIngestSettings = settings;
	return settings;
}

/**
 * Records a log line an agent sent.
 *
 * @param agentId the agent that sent it
 * @param frame the line
 * @returns whether it was recorded
 */
export async function ingestLog(agentId: string, frame: LogFrame): Promise<boolean> {
	if (!(await allow(agentId))) {
		return false;
	}

	// Populated by allow() above, which refreshes it whenever this agent's window is (re)created —
	// guaranteed to have run at least once by the time any window exists.
	const settings = globalForIngest.fenposLogIngestSettings as LogIngestSettings;

	// Resolved by name within this agent, so a agent cannot attribute a line to another's device
	// by naming it. A name that matches nothing records the line against the agent alone.
	const device = frame.device
		? await prisma.device.findFirst({
				where: { agentId, name: frame.device },
				select: { id: true },
			})
		: null;

	const entry = await prisma.logEntry.create({
		data: {
			level: frame.level,
			// Derived here rather than at read time: the filter and the Level ordering both run in the
			// database, and neither can compare a level string.
			severity: LOG_SEVERITY[frame.level],
			message: frame.message.slice(0, settings.maxMessageChars),
			agentId,
			deviceId: device?.id ?? null,
			// The agent's clock, kept because it is what the agent saw. Ordering across agents uses
			// the row's own sequence, since agent clocks are not synchronised with each other.
			ts: new Date(frame.at),
		},
		select: { id: true, ts: true, level: true, message: true },
	});

	publish({
		kind: "log",
		id: entry.id,
		at: entry.ts.toISOString(),
		level: entry.level as LogLevel,
		message: entry.message,
		agentId,
		deviceName: frame.device ?? null,
	});

	void sweepOccasionally(settings.maxRows);
	return true;
}

/**
 * Whether this agent may record another line right now.
 *
 * @param agentId the agent to check
 * @returns true when the line should be recorded
 */
async function allow(agentId: string): Promise<boolean> {
	const now = Date.now();
	const window = windows.get(agentId);

	if (!window || now >= window.resetAt) {
		await refreshLogIngestSettings();
		windows.set(agentId, { count: 1, resetAt: now + WINDOW_MS, warned: false });
		return true;
	}

	window.count++;
	// Set by refreshLogIngestSettings the last time any agent's window was (re)created, which has
	// happened at least once by the time a pre-existing window reaches this line.
	const settings = globalForIngest.fenposLogIngestSettings as LogIngestSettings;
	if (window.count <= settings.maxLinesPerWindow) {
		return true;
	}

	if (!window.warned) {
		window.warned = true;
		// Said once per window rather than per dropped line, which would be the same problem one
		// layer up.
		logger.warn("Agent log rate limit engaged; further lines are being dropped", {
			agentId,
			limit: settings.maxLinesPerWindow,
		});
	}
	return false;
}

/**
 * Drops the oldest rows once the table has grown past its cap.
 *
 * Counted in writes rather than scheduled on a timer, so a quiet install does no work at all and
 * a busy one sweeps in proportion to what it is producing.
 *
 * @param maxRows rows kept before the oldest are swept (`logs.maxRecords`)
 */
async function sweepOccasionally(maxRows: number): Promise<void> {
	const writes = (globalForIngest.fenposLogWrites ?? 0) + 1;
	globalForIngest.fenposLogWrites = writes;

	if (writes % SWEEP_EVERY !== 0) {
		return;
	}

	await sweepLogsNow(maxRows);
}

/**
 * Sweeps the log table down to `maxRows`, deleting the oldest rows first.
 *
 * Exported so a test can trigger a sweep directly rather than ingesting {@link SWEEP_EVERY} lines
 * to reach the point at which {@link sweepOccasionally} would trigger it on its own.
 *
 * @param maxRows rows kept before the oldest are swept (`logs.maxRecords`)
 */
export async function sweepLogsNow(maxRows: number): Promise<void> {
	try {
		const total = await prisma.logEntry.count();
		if (total <= maxRows) {
			return;
		}

		const cutoff = await prisma.logEntry.findMany({
			orderBy: { ts: "desc" },
			skip: maxRows - 1,
			take: 1,
			select: { ts: true },
		});

		if (cutoff.length > 0) {
			const removed = await prisma.logEntry.deleteMany({ where: { ts: { lt: cutoff[0].ts } } });
			logger.info("Swept old log entries", { removed: removed.count });
		}
	} catch (error) {
		// A failed sweep is not worth failing an ingest over; the next one will try again.
		logger.warn("Could not sweep old log entries", { error: String(error) });
	}
}

/** Forgets an agent's rate-limit window. Called when it disconnects. */
export function clearLogWindow(agentId: string): void {
	windows.delete(agentId);
}
