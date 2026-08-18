import "server-only";
import { prisma } from "@/lib/db";
import type { LogLevel } from "@/lib/domain/enums";
import { publish } from "@/lib/events/bus";
import type { LogFrame } from "@/lib/link/protocol";
import { logger } from "@/lib/logger";

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

/** Lines one agent may record per window before the rest are dropped. */
const MAX_LINES_PER_WINDOW = 120;

/** How long a rate-limit window lasts. */
const WINDOW_MS = 60_000;

/** Longest message stored. Anything beyond is truncated rather than rejected. */
const MAX_MESSAGE_LENGTH = 1000;

/** Rows kept before the oldest are swept. */
const MAX_ROWS = 20_000;

/** How often the sweep runs, measured in ingested lines rather than in time. */
const SWEEP_EVERY = 500;

interface Window {
	count: number;
	resetAt: number;
	/** Whether the agent has already been told it is being throttled, so it is said once. */
	warned: boolean;
}

const globalForIngest = globalThis as unknown as {
	fenposLogWindows: Map<string, Window> | undefined;
	fenposLogWrites: number | undefined;
};

if (!globalForIngest.fenposLogWindows) {
	globalForIngest.fenposLogWindows = new Map();
}

const windows: Map<string, Window> = globalForIngest.fenposLogWindows;

/**
 * Records a log line an agent sent.
 *
 * @param agentId the agent that sent it
 * @param frame the line
 * @returns whether it was recorded
 */
export async function ingestLog(agentId: string, frame: LogFrame): Promise<boolean> {
	if (!allow(agentId)) {
		return false;
	}

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
			message: frame.message.slice(0, MAX_MESSAGE_LENGTH),
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

	void sweepOccasionally();
	return true;
}

/**
 * Whether this agent may record another line right now.
 *
 * @param agentId the agent to check
 * @returns true when the line should be recorded
 */
function allow(agentId: string): boolean {
	const now = Date.now();
	const window = windows.get(agentId);

	if (!window || now >= window.resetAt) {
		windows.set(agentId, { count: 1, resetAt: now + WINDOW_MS, warned: false });
		return true;
	}

	window.count++;
	if (window.count <= MAX_LINES_PER_WINDOW) {
		return true;
	}

	if (!window.warned) {
		window.warned = true;
		// Said once per window rather than per dropped line, which would be the same problem one
		// layer up.
		logger.warn("Agent log rate limit engaged; further lines are being dropped", {
			agentId,
			limit: MAX_LINES_PER_WINDOW,
		});
	}
	return false;
}

/**
 * Drops the oldest rows once the table has grown past its cap.
 *
 * Counted in writes rather than scheduled on a timer, so a quiet install does no work at all and
 * a busy one sweeps in proportion to what it is producing.
 */
async function sweepOccasionally(): Promise<void> {
	const writes = (globalForIngest.fenposLogWrites ?? 0) + 1;
	globalForIngest.fenposLogWrites = writes;

	if (writes % SWEEP_EVERY !== 0) {
		return;
	}

	try {
		const total = await prisma.logEntry.count();
		if (total <= MAX_ROWS) {
			return;
		}

		const cutoff = await prisma.logEntry.findMany({
			orderBy: { ts: "desc" },
			skip: MAX_ROWS - 1,
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
