import "server-only";
import { prisma } from "@/lib/db";
import { type LogLevel, LogLevel as LogLevelSet } from "@/lib/domain/enums";

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
}

/**
 * Severity ordering, used to turn a chosen level into "this and worse".
 *
 * A filter that matched one level exactly would be nearly useless: someone looking for errors
 * still wants the warning that preceded it, and nobody wants to tick four boxes to see everything
 * that went wrong.
 */
const SEVERITY: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/**
 * Lists log lines, newest first.
 *
 * @param filter what to narrow to
 * @returns the page of lines and whether more follow
 */
export async function listLogs(filter: LogFilter = {}): Promise<{ lines: LogLine[]; more: boolean }> {
	const take = filter.take ?? LOG_PAGE_SIZE;

	const levels = filter.level
		? LogLevelSet.values.filter((level) => SEVERITY[level] >= SEVERITY[filter.level as LogLevel])
		: undefined;

	const rows = await prisma.logEntry.findMany({
		where: {
			...(filter.agentId ? { agentId: filter.agentId } : {}),
			...(levels ? { level: { in: [...levels] } } : {}),
		},
		orderBy: { ts: "desc" },
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
