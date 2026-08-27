import "server-only";
import { logsDb, prisma } from "@/lib/db";
import { type LogLevel, LogLevel as LogLevelSet } from "@/lib/domain/enums";
import { publish } from "@/lib/events/bus";
import { logger } from "@/lib/logger";
import { sweepOccasionally } from "@/lib/logs/ingest";
import { LOG_DEFAULT_SORT, LOG_SEVERITY, type LogSortColumn } from "@/lib/logs/log-sort";
import { globalLogIngestSettings, integerSetting } from "@/lib/settings/settings-service";
import type { SortDirection } from "@/lib/table/sort";

/**
 * Reading the log the agents forwarded.
 *
 * Ordered newest first, because the question being asked is almost always "what just happened".
 * An operator reading forward from an hour ago is doing archaeology; an operator reading down
 * from the top is watching a printer misbehave right now.
 */

/** One recorded line. */
export interface LogLine {
	id: string;
	at: string;
	level: LogLevel;
	message: string;
	agentName: string | null;
	deviceName: string | null;
}

/** What the list is narrowed to. */
export interface LogFilter {
	agentId?: string;
	/** Minimum severity: this level and anything above it. */
	level?: LogLevel;
	skip?: number;
	/** How many rows to return. Defaults to the configured `panel.logPageSize`. */
	take?: number;
	/** Which column to order by. Defaults to {@link LOG_DEFAULT_SORT}. */
	sort?: LogSortColumn;
	/** Which way that ordering runs. Defaults to {@link LOG_DEFAULT_SORT}. */
	desc?: boolean;
}

/**
 * How each sortable column becomes an `orderBy`.
 *
 * Keyed by {@link LogSortColumn}, so a column offered there without a mapping here is a type error
 * rather than a header that quietly does nothing.
 *
 * `source` groups by agent then device, which is the order the column reads in — though by id
 * rather than by name, for the reason below. Lines an agent recorded against no device sort first
 * within that agent, since a null id orders ahead of any id.
 */
const LOG_ORDER = {
	time: (dir: SortDirection) => ({ ts: dir }),
	// The stored number, not the level string: descending has to mean errors first.
	level: (dir: SortDirection) => ({ severity: dir }),
	// By the stored ids, not the names. The lines are in their own database now, so there is no
	// `agents` table for SQLite to join to and no name for it to order by; the ids still bring every
	// line from one source together, which is most of what the column is read for. Ordering the
	// column alphabetically again means storing the names on the row itself.
	source: (dir: SortDirection) => [{ agentId: dir }, { deviceId: dir }],
	message: (dir: SortDirection) => ({ message: dir }),
} as const satisfies Record<LogSortColumn, (dir: SortDirection) => unknown>;

/**
 * The severity filter is "this level and worse". Matching one level exactly would be nearly
 * useless: someone looking for errors still wants the warning that preceded it, and nobody wants
 * to tick four boxes to see everything that went wrong.
 *
 * Expressed as a comparison against the stored severity rather than as a set of level strings.
 * That is simpler, and it is what the severity index exists for.
 */
/**
 * The levels worth offering as a floor, which is not every level that can be stored.
 *
 * `DEBUG` is missing for two reasons, either of which would be enough. An agent cannot forward one
 * — `AgentLog` exposes `info`, `warn` and `error` and nothing else — so on a real install the
 * option matches rows that do not exist. And because the filter means "this level and worse", the
 * lowest severity selects everything, which is what no filter already does; offering it puts a
 * choice in front of an operator that cannot change what they see.
 *
 * `DEBUG` stays in {@link LogLevel} and in {@link LOG_SEVERITY}: the panel's own process logger uses it, the
 * agent's enum carries it, and rows holding it still read and display normally.
 */
export const FILTERABLE_LEVELS = LogLevelSet.values.filter((level) => LOG_SEVERITY[level] > LOG_SEVERITY.DEBUG);

/** Whether a value names a level the log list will narrow to. */
export function isFilterableLevel(value: string): value is LogLevel {
	return (FILTERABLE_LEVELS as readonly string[]).includes(value);
}

/**
 * Lists log lines, newest first.
 *
 * @param filter what to narrow to
 * @returns the page of lines and whether more follow
 */
export async function listLogs(filter: LogFilter = {}): Promise<{ lines: LogLine[]; more: boolean }> {
	const take = filter.take ?? (await integerSetting("panel.logPageSize"));

	const direction: SortDirection = (filter.desc ?? LOG_DEFAULT_SORT.desc) ? "desc" : "asc";
	const chosen = LOG_ORDER[filter.sort ?? LOG_DEFAULT_SORT.column](direction);
	// Newest-first breaks ties so a page boundary is stable: two lines from the same agent must not
	// swap places between one page view and the next, which would show one twice and hide another.
	const orderBy = [...(Array.isArray(chosen) ? chosen : [chosen]), { ts: "desc" as const }];

	const rows = await logsDb.logEntry.findMany({
		where: {
			...(filter.agentId ? { agentId: filter.agentId } : {}),
			...(filter.level ? { severity: { gte: LOG_SEVERITY[filter.level] } } : {}),
		},
		orderBy,
		skip: filter.skip ?? 0,
		take: take + 1,
	});

	const page = rows.slice(0, take);
	const names = await resolveSourceNames(page);

	return {
		more: rows.length > take,
		lines: page.map((row) => ({
			id: row.id,
			at: row.ts.toISOString(),
			level: (LogLevelSet.is(row.level) ? row.level : "INFO") as LogLevel,
			message: row.message,
			agentName: row.agentId === null ? null : (names.agents.get(row.agentId) ?? null),
			deviceName: row.deviceId === null ? null : (names.devices.get(row.deviceId) ?? null),
		})),
	};
}

/**
 * Names the agents and devices a page of lines came from.
 *
 * A second query rather than a join, because there is no join to make: the lines live in their own
 * database and hold ids the application's tables know nothing about. It is bounded by the page
 * size, not by the log, so it stays two queries however many rows are stored.
 *
 * An id that resolves to nothing reads as no name. That is now reachable — without a foreign key
 * to cascade them away, a deleted agent's lines outlive it — and it is the behaviour wanted: the
 * line still says what happened and when, which is why it was kept.
 *
 * @param rows the page whose sources need naming
 * @returns names by id, for the ids that still resolve
 */
async function resolveSourceNames(
	rows: readonly { agentId: string | null; deviceId: string | null }[],
): Promise<{ agents: Map<string, string>; devices: Map<string, string> }> {
	const agentIds = [...new Set(rows.map((row) => row.agentId).filter((id): id is string => id !== null))];
	const deviceIds = [...new Set(rows.map((row) => row.deviceId).filter((id): id is string => id !== null))];

	const [agents, devices] = await Promise.all([
		agentIds.length > 0
			? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
			: [],
		deviceIds.length > 0
			? prisma.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, name: true } })
			: [],
	]);

	return {
		agents: new Map(agents.map((agent) => [agent.id, agent.name])),
		devices: new Map(devices.map((device) => [device.id, device.name])),
	};
}

/**
 * Records a log line raised by the server itself, where an operator will see it.
 *
 * `logger` writes to stdout, which a log shipper reads and an operator generally does not. The Logs
 * tab reads `LogEntry` rows, and until now every one of those came from an agent. This is for the
 * few server-side events that belong in front of a person rather than in a file — the first being a
 * raw write, which is the one operation this server cannot describe after the fact.
 *
 * **Never throws.** Audit logging must not be the reason a request fails: a line lost is a nuisance,
 * a raw write refused because its audit line would not store is a fault, and one that happened and
 * then threw on the way out is the worst of the three.
 *
 * **Swept like any other row.** These lines land in the same table an agent's do, so they are
 * counted against `logs.maxRecords` through the same {@link sweepOccasionally} `ingestLog` uses
 * rather than growing behind it. That matters more here than there: the endpoint that writes these
 * is a write, and writes are deliberately not counted against `api.readsPerMinute` (see
 * `requireApiRead`), so nothing upstream bounds how many of these a key can produce.
 *
 * **Truncated to `logs.maxMessageChars`, exactly as `ingestLog` truncates an agent's lines.** One
 * table, one bound: an install that lowers the setting to keep its log rows small meant it for every
 * row, and a path that stored the full string regardless would leave the Logs tab showing two kinds
 * of line with two different limits. Callers may still shorten a field of their own first — the
 * raw-write route bounds the device name it was handed — since this cut lands on the end of the
 * sentence and a caller usually knows better which part is worth losing.
 *
 * @param level severity of the line
 * @param message what happened; stored truncated to `logs.maxMessageChars`
 * @param target the agent and device it concerns, when it concerns one
 */
export async function recordServerLog(
	level: LogLevel,
	message: string,
	target: { agentId?: string; deviceId?: string } = {},
): Promise<void> {
	try {
		// Read here rather than cached the way `ingestLog` caches them: that path runs per line for
		// every agent on the install, this one runs on the few server-side events worth showing an
		// operator, so one settings read is not worth a second cache to avoid. Read before the insert
		// because `maxMessageChars` bounds the row itself; the sweep below uses the other two of the
		// three values this same read produces.
		const { maxRecords, maxMessageChars, sweepEvery } = await globalLogIngestSettings();

		const entry = await logsDb.logEntry.create({
			data: {
				level,
				// Derived here rather than at read time, exactly as `ingestLog` does: the severity
				// filter and the Level column ordering both run in the database, and neither can
				// compare a level string.
				severity: LOG_SEVERITY[level],
				message: message.slice(0, maxMessageChars),
				agentId: target.agentId ?? null,
				deviceId: target.deviceId ?? null,
			},
			select: { id: true, ts: true, level: true, message: true },
		});

		// LogEvent.agentId is non-nullable — it is the live stream an agent's own frames publish
		// to. Publishing here without a real agent would misattribute the line to no one in
		// particular; skipping it when there is none still leaves the row itself in place, so the
		// Logs tab shows it on the next read. The raw-write caller always names an agent, so the
		// live path is exercised in practice.
		if (target.agentId) {
			publish({
				kind: "log",
				id: entry.id,
				at: entry.ts.toISOString(),
				level: entry.level as LogLevel,
				message: entry.message,
				agentId: target.agentId,
				deviceName: null,
			});
		}

		void sweepOccasionally(maxRecords, sweepEvery);
	} catch (error) {
		logger.error("Could not record a server log line", error, { message });
	}
}
