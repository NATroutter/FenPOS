import "server-only";
import { AUDIT_DEFAULT_SORT, type AuditSortColumn } from "@/lib/audit/audit-sort";
import { AUTH_AUDIT_ACTIONS } from "@/lib/audit/auth-events";
import { SYSTEM_AUDIT_ACTIONS } from "@/lib/audit/system-actions";
import { PANEL_ACTIONS } from "@/lib/auth/panel-actions";
import { RECOVERY_AUDIT_ACTIONS } from "@/lib/auth/recovery-actions";
import { prisma } from "@/lib/db";
import { type AuditOutcome, AuditOutcome as AuditOutcomeSet } from "@/lib/domain/audit";
import type { SortDirection } from "@/lib/table/sort";

/**
 * Reading the audit record.
 *
 * Read-only, and there is nothing else it could be: `AuditEvent` has no update path and its one
 * delete path is `lib/audit/retention.ts`. A module here that could change a row would contradict the
 * whole shape of the record, so this one reads two things and writes nothing.
 *
 * Paged and filtered in the database rather than in the page, because on an install that has been
 * running a year this table is larger than everything else in the schema put together — and because a
 * filter applied to the fifty rows that happened to be fetched would answer a different question than
 * the one it appears to answer.
 */

/** One event as the Audit tab displays it. */
export interface AuditEventSummary {
	seq: number;
	at: string;
	/** Who did it, already resolved from whichever actor columns are populated. */
	actor: string;
	actorKind: string;
	/** Null for every non-`USER` actor, and for a sign-in against an address matching no account. */
	actorUserId: string | null;
	actorEmail: string | null;
	action: string;
	outcome: AuditOutcome;
	targetKind: string | null;
	targetId: string | null;
	targetLabel: string | null;
	/** The stored JSON text, unparsed. The detail pane renders it; nothing here interprets it. */
	detail: string | null;
	ipAddress: string | null;
	userAgent: string | null;
}

/**
 * Every action id a row can carry, sorted.
 *
 * Built from the three declaring modules rather than from a `SELECT DISTINCT action`, because the
 * action somebody wants to filter for is very often one that has not happened — "has anybody deleted
 * a user" is a question whose useful answer is no, and a filter built from what is present cannot ask
 * it.
 */
export const KNOWN_AUDIT_ACTIONS: readonly string[] = [
	...new Set([
		...PANEL_ACTIONS.map((entry) => entry.id),
		...Object.values(AUTH_AUDIT_ACTIONS),
		...SYSTEM_AUDIT_ACTIONS,
		...Object.values(RECOVERY_AUDIT_ACTIONS),
	]),
].sort();

/**
 * How each sortable column becomes an `orderBy`.
 *
 * The names live in `audit-sort.ts`, which the table imports too; this is the half that reaches
 * Prisma and so stays behind `server-only`. Keyed by that same union, so a column added there without
 * a mapping here is a type error rather than a silent no-op.
 *
 * `at` maps to `seq` — see that module's comment for why.
 */
const AUDIT_ORDER = {
	at: (dir: SortDirection) => ({ seq: dir }),
	action: (dir: SortDirection) => ({ action: dir }),
	actor: (dir: SortDirection) => ({ actorName: dir }),
	outcome: (dir: SortDirection) => ({ outcome: dir }),
} as const satisfies Record<AuditSortColumn, (dir: SortDirection) => unknown>;

/** What the list is narrowed to. */
export interface AuditFilter {
	/** One account, by id. Rows with no `actorUserId` are excluded by it. */
	actorUserId?: string;
	action?: string;
	outcome?: AuditOutcome;
	/** One thing that was acted on, by its denormalised id. */
	targetId?: string;
	/** Inclusive lower bound on `at`. */
	from?: Date;
	/** Inclusive upper bound on `at`. */
	to?: Date;
	/** How many to skip, for paging. */
	skip?: number;
	/** Which column to order by. Defaults to {@link AUDIT_DEFAULT_SORT}. */
	sort?: AuditSortColumn;
	/** Which way that ordering runs. Defaults to {@link AUDIT_DEFAULT_SORT}. */
	desc?: boolean;
	/** How many rows to return. Defaults to {@link DEFAULT_PAGE_SIZE}. */
	take?: number;
}

/**
 * Rows per page.
 *
 * A constant rather than a setting: `panel.jobPageSize` exists because an operator watching a busy
 * kitchen genuinely wants a different number than one watching a quiet one, and nobody has that
 * relationship with an audit table. One less knob on a page that already has five filters.
 */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Lists events, newest first.
 *
 * @param filter what to narrow to
 * @returns the page of events and whether more follow
 */
export async function listAuditEvents(
	filter: AuditFilter = {},
): Promise<{ events: AuditEventSummary[]; more: boolean }> {
	const where = {
		...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
		...(filter.action ? { action: filter.action } : {}),
		...(filter.outcome ? { outcome: filter.outcome } : {}),
		...(filter.targetId ? { targetId: filter.targetId } : {}),
		...(filter.from || filter.to
			? { at: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
			: {}),
	};

	const direction: SortDirection = (filter.desc ?? AUDIT_DEFAULT_SORT.desc) ? "desc" : "asc";
	const chosen = AUDIT_ORDER[filter.sort ?? AUDIT_DEFAULT_SORT.column](direction);
	// `seq` last as the tiebreak, and it is a real one: two rows can share an action, an actor or an
	// outcome, and without it a page boundary in those orderings would show a row twice.
	const orderBy = [chosen, { seq: "desc" as const }];

	const take = filter.take ?? DEFAULT_PAGE_SIZE;

	// One extra row rather than a count: counting this table on every page view is a scan run to
	// answer a question worth one boolean.
	const rows = await prisma.auditEvent.findMany({ where, orderBy, skip: filter.skip ?? 0, take: take + 1 });

	return {
		more: rows.length > take,
		events: rows.slice(0, take).map((row) => ({
			seq: row.seq,
			at: row.at.toISOString(),
			actor: actorLabel(row),
			actorKind: row.actorKind,
			actorUserId: row.actorUserId,
			actorEmail: row.actorEmail,
			action: row.action,
			// A stored value outside the closed set is not a thing this system writes, but it is a thing
			// a tampered row could hold. Read as FAILURE rather than trusted through: the chip has to
			// render something, and the safe something is the one that draws attention.
			outcome: (AuditOutcomeSet.is(row.outcome) ? row.outcome : "FAILURE") as AuditOutcome,
			targetKind: row.targetKind,
			targetId: row.targetId,
			targetLabel: row.targetLabel,
			detail: row.detail,
			ipAddress: row.ipAddress,
			userAgent: row.userAgent,
		})),
	};
}

/**
 * One line naming whoever did it, whatever kind of actor that was.
 *
 * The email is the fallback for a `USER` row with no name, which is what a refused sign-in against an
 * unknown address produces — and on that row the address is the single most useful thing there is.
 *
 * @param row the stored event
 * @returns the label to show in the actor column
 */
function actorLabel(row: {
	actorKind: string;
	actorName: string | null;
	actorEmail: string | null;
	apiKeyName: string | null;
}): string {
	switch (row.actorKind) {
		case "USER":
			return row.actorName ?? row.actorEmail ?? "Unknown";
		case "API_KEY":
			return row.apiKeyName ?? "Deleted key";
		case "SETUP":
			return "Setup";
		case "CLI":
			return "Command line";
		default:
			return "System";
	}
}

/** The choices the Audit tab's filter row offers. */
export interface AuditFilterOptions {
	/** Accounts that appear in the record, by id, including ones since deleted. */
	actors: { id: string; label: string }[];
	/** Every action a row could carry. */
	actions: readonly string[];
}

/**
 * The filter row's choices.
 *
 * The actor list comes from the record rather than from the `user` table, and that is the point: an
 * account can be deleted and its trail survives it (`actorUserId` is a plain column, not a relation),
 * so filtering by "who" has to offer the people who are gone. They are the ones somebody is usually
 * looking for.
 *
 * @returns the actor and action choices
 */
export async function auditFilterOptions(): Promise<AuditFilterOptions> {
	const rows = await prisma.auditEvent.findMany({
		where: { actorUserId: { not: null } },
		distinct: ["actorUserId"],
		orderBy: { seq: "desc" },
		select: { actorUserId: true, actorName: true, actorEmail: true },
	});

	return {
		actors: rows
			.map((row) => ({
				id: row.actorUserId as string,
				label: row.actorName ?? row.actorEmail ?? (row.actorUserId as string),
			}))
			// "en" pinned explicitly rather than left to the platform default: ICU collation varies by
			// host locale, and the same install should list its people in the same order on every
			// machine that serves it.
			.sort((a, b) => a.label.localeCompare(b.label, "en")),
		actions: KNOWN_AUDIT_ACTIONS,
	};
}
