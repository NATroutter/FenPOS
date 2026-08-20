import "server-only";
import { prisma } from "@/lib/db";
import { type LogLevel, LogLevel as LogLevelSet } from "@/lib/domain/enums";
import { LOG_DEFAULT_SORT, LOG_SEVERITY, type LogSortColumn } from "@/lib/logs/log-sort";
import type { SortDirection } from "@/lib/table/sort";

/**
 * Reading the log the agents forwarded.
 *
 * Ordered newest first, because the question being asked is almost always "what just happened".
 * An operator reading forward from an hour ago is doing archaeology; an operator reading down
 * from the top is watching a printer misbehave right now.
 */

/** How many lines one page holds. */
export const LOG_PAGE_SIZE = 100;

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
 * `source` orders by agent then device, which is how the column reads on screen. Lines an agent
 * recorded against no device sort first within that agent, since a null device name orders ahead of
 * any name.
 */
const LOG_ORDER = {
	time: (dir: SortDirection) => ({ ts: dir }),
	// The stored number, not the level string: descending has to mean errors first.
	level: (dir: SortDirection) => ({ severity: dir }),
	source: (dir: SortDirection) => [{ agent: { name: dir } }, { device: { name: dir } }],
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
	const take = filter.take ?? LOG_PAGE_SIZE;

	const direction: SortDirection = (filter.desc ?? LOG_DEFAULT_SORT.desc) ? "desc" : "asc";
	const chosen = LOG_ORDER[filter.sort ?? LOG_DEFAULT_SORT.column](direction);
	// Newest-first breaks ties so a page boundary is stable: two lines from the same agent must not
	// swap places between one page view and the next, which would show one twice and hide another.
	const orderBy = [...(Array.isArray(chosen) ? chosen : [chosen]), { ts: "desc" as const }];

	const rows = await prisma.logEntry.findMany({
		where: {
			...(filter.agentId ? { agentId: filter.agentId } : {}),
			...(filter.level ? { severity: { gte: LOG_SEVERITY[filter.level] } } : {}),
		},
		orderBy,
		skip: filter.skip ?? 0,
		take: take + 1,
		include: {
			agent: { select: { name: true } },
			device: { select: { name: true } },
		},
	});

	const page = rows.slice(0, take);

	return {
		more: rows.length > take,
		lines: page.map((row) => ({
			id: row.id,
			at: row.ts.toISOString(),
			level: (LogLevelSet.is(row.level) ? row.level : "INFO") as LogLevel,
			message: row.message,
			agentName: row.agent?.name ?? null,
			deviceName: row.device?.name ?? null,
		})),
	};
}
