import "server-only";
import { logsDb, prisma } from "@/lib/db";
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
 * Retention is bounded for a related reason — this table exists to answer "what happened this
 * shift" — but it is not enforced here. It runs on `lib/maintenance/pass.ts`'s timer, off the
 * ingest path entirely, because a sweep now archives a period before it deletes it and nothing that
 * opens and gzips a database belongs behind a log line.
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
}

const globalForIngest = globalThis as unknown as {
	fenposLogWindows: Map<string, Window> | undefined;
	fenposLogIngestSettings: LogIngestSettings | undefined;
};

if (!globalForIngest.fenposLogWindows) {
	globalForIngest.fenposLogWindows = new Map();
}

const windows: Map<string, Window> = globalForIngest.fenposLogWindows;

/**
 * Re-reads the two `logs.*` settings from the database and caches them.
 *
 * `ingestLog` runs on the hot path for every line every agent sends, so reading these settings
 * there directly would be a database query per line. Instead this is called only from {@link allow}
 * when an agent's rate-limit window is (re)created — its first line, or its first line after 60
 * seconds of quiet — which happens at most once per agent per window rather than once per line.
 * The settings themselves change, at most, a few times a year, so the cost is a change made
 * mid-window reaching an already-connected agent up to one window late, in exchange for turning a
 * per-line query into roughly one per agent per minute.
 *
 * Reads both as one {@link globalLogIngestSettings} call rather than one settings lookup each — the
 * same reason that function itself reads `listSettings()` once rather than per key.
 *
 * @returns the settings just read
 */
async function refreshLogIngestSettings(): Promise<LogIngestSettings> {
	const { linesPerMinutePerAgent, maxMessageChars } = await globalLogIngestSettings();

	const settings: LogIngestSettings = { maxLinesPerWindow: linesPerMinutePerAgent, maxMessageChars };
	globalForIngest.fenposLogIngestSettings = settings;
	return settings;
}

/**
 * Records a log line an agent sent.
 *
 * **Never throws**, for the same reason `recordServerLog` (`lib/logs/log-service.ts`) never does: the
 * caller is `agent-connection.ts`'s frame switch, which invokes this as `void ingestLog(...)` with
 * nothing to catch a rejection, and the project installs no `unhandledRejection` handler. An
 * unmigrated, unwritable, or full `logs.db` must not turn one agent's log line into a crash — and
 * under `compose.yaml`'s `restart: unless-stopped`, a crash there is a crash loop, not a one-off.
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

	try {
		// Resolved by name within this agent, so a agent cannot attribute a line to another's device
		// by naming it. A name that matches nothing records the line against the agent alone.
		//
		// Run alongside the agent's own name, rather than after it: `LogEntry.agentName` denormalises
		// the name onto the row for the same reason `AuditEvent` denormalises its actor (see
		// `prisma/logs.prisma`), and `LogFrame` carries no name for the server to reuse, so a lookup is
		// unavoidable — the two run together so it costs no extra round trip over resolving the device
		// alone.
		const [device, agent] = await Promise.all([
			frame.device
				? prisma.device.findFirst({
						where: { agentId, name: frame.device },
						select: { id: true },
					})
				: null,
			prisma.agent.findUnique({ where: { id: agentId }, select: { name: true } }),
		]);

		// Only when the name actually resolved to a device of this agent's: a name that matches
		// nothing, or names another agent's device, attributes the line to no device at all (see the
		// lookup above). Shared between the stored row and the published event below, so a live
		// subscriber and a page reload cannot disagree about what the line was attributed to.
		const deviceName = device ? (frame.device ?? null) : null;

		const entry = await logsDb.logEntry.create({
			data: {
				level: frame.level,
				// Derived here rather than at read time: the filter and the Level ordering both run in
				// the database, and neither can compare a level string.
				severity: LOG_SEVERITY[frame.level],
				message: frame.message.slice(0, settings.maxMessageChars),
				agentId,
				agentName: agent?.name ?? null,
				deviceId: device?.id ?? null,
				deviceName,
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
			deviceName,
		});

		return true;
	} catch (error) {
		// Swallowed on purpose — see the doc comment above. Logged with the agent id so a line missing
		// from the Logs tab is diagnosable rather than merely absent.
		logger.error("Could not record an agent's log line", error, { agentId });
		return false;
	}
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

/** Forgets an agent's rate-limit window. Called when it disconnects. */
export function clearLogWindow(agentId: string): void {
	windows.delete(agentId);
}
