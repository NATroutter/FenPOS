import "server-only";
import { periodKeyFor } from "@/lib/archive/period";
import { listArchives } from "@/lib/archive/read";
import { logsDb } from "@/lib/db";
import { type LogLevel, LogLevel as LogLevelSet } from "@/lib/domain/enums";
import { publish } from "@/lib/events/bus";
import { logger } from "@/lib/logger";
import { LOG_DEFAULT_SORT, LOG_SEVERITY, type LogSortColumn } from "@/lib/logs/log-sort";
import { archiveDirectory } from "@/lib/maintenance/pass";
import { globalLogIngestSettings, integerSetting } from "@/lib/settings/settings-service";
import { anyOf } from "@/lib/table/multi-filter";
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
	/**
	 * The API key that produced the line, when one did. No relation backs this — `logs.db` cannot
	 * join to the application's tables — so once the key is deleted this id resolves to nothing; the
	 * key's name lives in `message` instead, which is what stays readable after that happens. See
	 * `LogEntry.apiKeyId`.
	 */
	apiKeyId: string | null;
}

/**
 * What the list is narrowed to.
 *
 * Each of the first three takes one value or several: the tab's dropdowns are multi-select, so
 * "either of these two agents" is one question rather than two page loads. One value still becomes
 * an `equals` rather than a one-element `in` — see `anyOf` (`lib/table/multi-filter.ts`).
 */
export interface LogFilter {
	agentId?: string | string[];
	/**
	 * The API key that produced the line. Matched on the id alone — a key that has since been
	 * deleted still narrows to its own lines, because nothing nulls the column out. See
	 * {@link LogLine.apiKeyId}.
	 */
	apiKeyId?: string | string[];
	/** The severities to list. Exactly these levels, not a floor — see the note on {@link FILTERABLE_LEVELS}. */
	level?: LogLevel | LogLevel[];
	/** The earliest moment to list, inclusive. */
	from?: Date;
	/** The latest moment to list, inclusive. */
	to?: Date;
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
 * `source` groups by agent name then device name, which is the order the column reads in and
 * keeps every line from one source together, alphabetically. Lines an agent recorded against no
 * device sort first within that agent, since a null name orders ahead of any name.
 */
const LOG_ORDER = {
	time: (dir: SortDirection) => ({ ts: dir }),
	// The stored number, not the level string: descending has to mean errors first.
	level: (dir: SortDirection) => ({ severity: dir }),
	source: (dir: SortDirection) => [{ agentName: dir }, { deviceName: dir }],
	message: (dir: SortDirection) => ({ message: dir }),
} as const satisfies Record<LogSortColumn, (dir: SortDirection) => unknown>;

/**
 * The levels the list will narrow to, which is not every level that can be stored.
 *
 * **These are the levels themselves, not a floor.** The filter used to mean "this level and worse",
 * expressed as `severity >= n`, on the reasoning that nobody wants to tick four boxes to see
 * everything that went wrong. The dropdown is multi-select now, so ticking two is one gesture and
 * the floor has become the strictly less expressive reading: "warn and worse" is still one click,
 * and "warn and error but not fatal" — which the floor could not ask at all — is two.
 *
 * `DEBUG` is still missing. Only one of its two original reasons survives the change, and it is
 * enough on its own: an agent cannot forward one, since `AgentLog` exposes `info`, `warn` and
 * `error` and nothing else, so on a real install the option matches rows that do not exist.
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

	const agentId = anyOf(filter.agentId);
	const apiKeyId = anyOf(filter.apiKeyId);
	// Matched on the stored severity rather than the level string, which is what the severity index
	// exists for — the levels are mapped to their numbers here and the set is compared against those.
	const levels = filter.level === undefined ? [] : Array.isArray(filter.level) ? filter.level : [filter.level];
	const severity = anyOf(levels.map((level) => LOG_SEVERITY[level]));

	const rows = await logsDb.logEntry.findMany({
		where: {
			...(agentId ? { agentId } : {}),
			...(apiKeyId ? { apiKeyId } : {}),
			...(severity ? { severity } : {}),
			// One `ts` key or none: two spread objects would have the second overwrite the first, so a
			// range with both ends would silently lose its lower bound.
			...(filter.from || filter.to
				? { ts: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
				: {}),
		},
		orderBy,
		skip: filter.skip ?? 0,
		take: take + 1,
	});

	const page = rows.slice(0, take);

	return {
		more: rows.length > take,
		lines: page.map((row) => ({
			id: row.id,
			at: row.ts.toISOString(),
			level: (LogLevelSet.is(row.level) ? row.level : "INFO") as LogLevel,
			message: row.message,
			agentName: row.agentName,
			deviceName: row.deviceName,
			apiKeyId: row.apiKeyId,
		})),
	};
}

/**
 * The stretch of time a filtered view is asking about.
 *
 * Both ends optional, because the tab's two date fields are set independently: "everything since
 * March" and "everything up to March" are both ranges an operator can ask for, and either can reach
 * back past the live window. A range with neither end is the whole log, which is the unfiltered tab
 * — see {@link archiveCovering} for why that is a question the caller does not ask.
 */
export interface LogRange {
	/** The earliest moment asked for. Absent means the range is open at that end. */
	from?: Date;
	/** The latest moment asked for. Absent means "up to now", which is what an open range ends at. */
	to?: Date;
}

/**
 * Finds the archived period a filtered range reaches into, if there is one.
 *
 * This is the signpost behind the Logs tab. Retention moves whole months out of `logs.db` and into
 * `<archives>/logs-<period>.db.gz`; without something saying so, a range that reaches back past the
 * live window returns a short page or an empty one, and the operator's failure is no longer "the
 * data is gone" but "the data is somewhere nobody told you to look" — which is the failure this
 * whole split was supposed to remove rather than relocate.
 *
 * **Which archive covers a range.** A `logs` archive covers it when its period holds any moment the
 * range asks for: `periodKeyFor(from) <= periodKey <= periodKeyFor(to ?? now)`, with a range open at
 * the start matching every period up to its end. When several do — a range reaching back across
 * months that have each been archived — the **oldest** is returned, because that is where the
 * requested history begins and so the period to open first. An archive later than the range's end is
 * not offered at all: it holds nothing that was asked for, and a signpost pointing at data outside
 * the range is worse than none.
 *
 * **A range with neither end is every archive there is, and answering that is not this function's
 * mistake to prevent.** The caller asks when a range was filtered on; a tab that has not been
 * filtered is not asking about a stretch of history, and an archive offered on every default page
 * load would be noise wearing a signpost's clothes.
 *
 * **Why this needs no separate reading of where the live window starts.** A file at a period's
 * finished name is only reachable after that period's live rows are gone. `archivePeriod` writes
 * under a provisional `*.partial` name, verifies it, deletes the live rows in a transaction, and only
 * *then* renames to `<source>-<period>.db` and compresses — the delete and the rename are not one
 * transaction, and `lib/archive/rotate.ts` says what that costs: a crash between any two steps leaves
 * rows **duplicated**, never lost. Duplication is the only direction the ordering allows, so a listed
 * archive still implies the delete happened. That makes a match evidence that the range reaches back
 * before the live window, and deriving that boundary a second time here would be a second opinion
 * about it.
 *
 * **The converse does not hold, and the gap is real rather than theoretical.** `listArchives` matches
 * `.db.gz` only, deliberately (`lib/archive/read.ts`), so a period whose *compression* failed is a
 * complete, named archive that nothing here can see — its rows are out of the live window and no
 * signpost appears for them until somebody compresses or moves that file. This reader inherits that
 * blind spot rather than opening a second way to read an archive beside the one the panel already
 * has; Task 13's delete refuses outright on the same seam, because there the cost is a false tamper
 * report and here it is one banner that does not appear.
 *
 * **Audit archives are never offered**, and the test for that is the parsed `source` rather than the
 * filename: this reader holds `logs:read` and may be holding nothing else, and the audit record is
 * not theirs to be pointed at.
 *
 * **Never throws.** The Logs tab's job is showing live lines; an archive directory an operator has
 * provisioned wrongly must not be the reason the tab stops rendering. The failure goes to the server
 * log and the signpost simply does not appear — the same silence as "nothing has been archived yet",
 * which is the honest answer when nobody can tell.
 *
 * @param range what the filtered view is asking about; at least one end should be set, or the answer
 *   is about the whole log rather than about anything the operator narrowed to
 * @returns the period key of the oldest log archive holding any of it, e.g. `2026-03`, or null when
 *   no archive does, or when the archive directory could not be read
 */
export async function archiveCovering(range: LogRange): Promise<string | null> {
	// UTC on both sides of every comparison below, because archive periods are UTC — `periodKeyFor`
	// says why, and a boundary that moved with the host's zone would put a range that ends at 22:30
	// on the last of March into April on this machine and not on the next one.
	//
	// The empty string sorts before every `yyyy-mm`, so an open start matches every period rather than
	// none — which is what "everything up to March" asks for.
	const first = range.from === undefined ? "" : periodKeyFor(range.from);
	const last = periodKeyFor(range.to ?? new Date());

	try {
		let covering: string | null = null;

		for (const archive of await listArchives(archiveDirectory())) {
			if (archive.source !== "logs" || archive.periodKey < first || archive.periodKey > last) {
				continue;
			}
			// `periodKey` is `yyyy-mm` with the month zero-padded, so comparing two of them as text
			// orders them exactly as comparing them as dates would.
			if (covering === null || archive.periodKey < covering) {
				covering = archive.periodKey;
			}
		}

		return covering;
	} catch (error) {
		logger.error("Could not look for an archive covering the filtered range", error, { from: first, to: last });
		return null;
	}
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
 * **Swept like any other row.** These lines land in the same table an agent's do, so they age out
 * under `logs.retentionDays` through `lib/maintenance/pass.ts`'s hourly pass rather than growing
 * behind it — and this path does nothing to bring that about, which is the point: retention is a
 * property of the table now, not of whoever happened to write the row. That matters more here than
 * for an agent's lines: the endpoint that writes these is a write, and writes are deliberately not
 * counted against `api.readsPerMinute` (see `requireApiRead`), so nothing upstream bounds how many
 * of these a key can produce.
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
 * @param target the agent and device it concerns, when it concerns one. `agentName`/`deviceName`
 * are denormalised onto the row exactly as `ingestLog` denormalises them for an agent's own lines,
 * so the caller supplies them rather than this function looking them up — see `LogEntry.agentName`.
 * `apiKeyId` names the API key that caused the line, when one did; unlike `agentName`/`deviceName`
 * it has no denormalised name column, so a caller that wants the line to stay meaningful after the
 * key is deleted must put the key's name in `message` itself — see `LogEntry.apiKeyId`.
 */
export async function recordServerLog(
	level: LogLevel,
	message: string,
	target: { agentId?: string; agentName?: string; deviceId?: string; deviceName?: string; apiKeyId?: string } = {},
): Promise<void> {
	try {
		// Read here rather than cached the way `ingestLog` caches them: that path runs per line for
		// every agent on the install, this one runs on the few server-side events worth showing an
		// operator, so one settings read is not worth a second cache to avoid. Read before the insert
		// because `maxMessageChars` bounds the row itself.
		const { maxMessageChars } = await globalLogIngestSettings();

		const entry = await logsDb.logEntry.create({
			data: {
				level,
				// Derived here rather than at read time, exactly as `ingestLog` does: the severity
				// filter and the Level column ordering both run in the database, and neither can
				// compare a level string.
				severity: LOG_SEVERITY[level],
				message: message.slice(0, maxMessageChars),
				agentId: target.agentId ?? null,
				agentName: target.agentName ?? null,
				deviceId: target.deviceId ?? null,
				deviceName: target.deviceName ?? null,
				apiKeyId: target.apiKeyId ?? null,
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
				deviceName: target.deviceName ?? null,
			});
		}
	} catch (error) {
		logger.error("Could not record a server log line", error, { message });
	}
}
