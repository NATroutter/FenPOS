"use server";

import type Database from "better-sqlite3";
import { type ArchiveDescriptor, listArchives, readArchive } from "@/lib/archive/read";
import type { ArchiveSource } from "@/lib/archive/rotate";
import { recordAudit, userActor } from "@/lib/audit/audit-log";
import { requestProvenance } from "@/lib/audit/provenance";
import { userHolds } from "@/lib/auth/effective-permissions";
import { panelQuery } from "@/lib/auth/panel-action";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import { currentSessionId, type PanelUser } from "@/lib/auth/require-session";
import { archiveDirectory } from "@/lib/maintenance/pass";

/**
 * Server actions behind the Archives tab.
 *
 * An archive nobody can read is storage, not a record. Everything else on this branch moves whole
 * periods out of the live databases and into `<source>-<period>.db.gz`; these two are what turn that
 * from "the rows are gone" into "the rows are over here".
 *
 * **Opened on demand, never on page load.** {@link listArchivePeriods} reads a directory listing and
 * a size per file, which is cheap and safe to do while rendering. {@link readArchivePage}
 * decompresses a whole period into a temporary file and opens SQLite on it, which on a busy install's
 * month is the most expensive read the panel can perform — so it runs when somebody asks for a
 * period, and never as a side effect of arriving at the tab.
 *
 * **No new permission.** An archive is the same data through a different file, so a log period is
 * `logs:read` and an audit period is `audit:read`. The registry names one permission per action and
 * `logs:read` is what it names, because that is also what opens the page these run behind; which
 * permission governs a *period* depends on the period's source, which is an argument rather than a
 * property of the action, so the second half of the rule is checked in {@link readArchivePage}'s own
 * body and its refusal is recorded there.
 *
 * **Neither of these two removes anything.** Log archives are pruned by `pruneLogArchives` on the
 * maintenance pass; an audit archive may only be removed alongside the epoch that vouches for it,
 * which is a deliberate action under a permission of its own rather than anything a read does.
 */

/** One archived period, as the tab lists it before anybody opens anything. */
export interface ArchivePeriod {
	/** The period the archive covers, e.g. `2026-01`. */
	periodKey: string;
	/** Which live database this period was drained from. */
	source: ArchiveSource;
	/** The compressed file's size in bytes, so an operator can see what opening it will cost. */
	bytes: number;
}

/**
 * Which archive to open.
 *
 * Deliberately not `ArchiveDescriptor`, which carries the file's `path`. That value crosses to the
 * browser and would come back from it, and a server action that opens whatever path it is handed is
 * an arbitrary file read wearing a period's name. A source and a period are matched against the
 * directory listing instead, so the only files these actions can ever open are the ones
 * `listArchives` already found.
 */
export interface ArchiveRef {
	source: ArchiveSource;
	periodKey: string;
}

/** How a read narrows what it brings back. */
export interface ArchivePageFilters {
	/** Free text, matched against the row's own words. Absent or empty means no filter. */
	search?: string;
	/** How many matching rows to step over first. */
	skip?: number;
}

/**
 * One row out of an opened period.
 *
 * A union rather than one flattened shape, because the two sources are read for different questions:
 * a log line is read for its message and a recorded event is read for who did what and whether it
 * worked. Flattening them would put the audit record's actor and outcome into a column called
 * "message" and lose the distinction the record exists to make.
 */
export type ArchiveRow =
	| {
			kind: "logs";
			/** The line's own id, which is also the table's key for it. */
			id: string;
			/** When, as the archive stores it: ISO-8601 with an explicit offset. */
			at: string;
			level: string;
			message: string;
			/** The agent the line came from, when it named one. */
			origin: string | null;
	  }
	| {
			kind: "audit";
			/** The event's `seq`, as text, so both halves of the union key a row the same way. */
			id: string;
			/** When, as the archive stores it: ISO-8601 with an explicit offset. */
			at: string;
			actor: string;
			action: string;
			outcome: string;
			target: string | null;
	  };

/** What one read hands back: the rows, whether there are more, or the reason there are none. */
export interface ArchivePage {
	rows: ArchiveRow[];
	/** True when the period holds further matching rows past this page. */
	more: boolean;
	/** The reason there are no rows, when there is one. Null when the read succeeded. */
	error: string | null;
}

/** The most rows one read carries back. */
const PAGE_SIZE = 100;

/** The message for a read that broke rather than one that was refused. */
const FAILURE_MESSAGE = "The archive could not be read. Check the server log.";

/**
 * Which existing permission governs each source.
 *
 * A `Map` rather than a record literal, so a `source` arriving off the wire is *looked up* rather
 * than used as an index — `"__proto__" in someObject` is true, and a lookup that answered for it
 * would be a permission check answering about a key nothing wrote.
 */
const PERMISSION_FOR = new Map<string, "logs:read" | "audit:read">([
	["logs", "logs:read"],
	["audit", "audit:read"],
]);

/**
 * Lists the periods on disk that this caller may read.
 *
 * Newest first, because the period somebody has come looking for is almost always the one that has
 * just aged out. `listArchives` promises no order at all — it returns the directory in whatever order
 * the filesystem gave it, which interleaves the two sources by filename at best — so the ordering is
 * put on here rather than relied on from there.
 *
 * A caller without `audit:read` is shown the log periods and not the audit ones, rather than being
 * refused outright: the tab is opened with `logs:read`, and which months of the audit record exist
 * is itself something `audit:read` governs.
 *
 * @returns every readable period, newest first; an empty list when refused or when the directory
 *   could not be read, in both of which cases the record says so
 */
export async function listArchivePeriods(): Promise<ArchivePeriod[]> {
	return panelQuery<ArchivePeriod[]>(
		"archives:list",
		async (user) => {
			const readable = await readableSources(user);
			const found = await listArchives(archiveDirectory());

			return found
				.filter((archive) => readable.includes(archive.source))
				.map((archive) => ({ periodKey: archive.periodKey, source: archive.source, bytes: archive.bytes }))
				.sort(newestFirst);
		},
		{ refused: () => [], failed: () => [] },
	);
}

/**
 * Opens one period and reads a page out of it.
 *
 * The expensive half of the tab, and the reason the other half exists: this decompresses the whole
 * period into a temporary file before it can run a single query. It is called when somebody picks a
 * period, never while rendering the list.
 *
 * The archive is found by matching `descriptor` against the directory listing rather than by opening
 * a path the caller supplied — see {@link ArchiveRef}. A period that is not in the listing is
 * reported as missing rather than searched for anywhere else.
 *
 * @param descriptor which period to open, named rather than pathed
 * @param filters what to search for, and how far in
 * @returns the page, or the reason there is none
 */
export async function readArchivePage(descriptor: ArchiveRef, filters: ArchivePageFilters): Promise<ArchivePage> {
	// Given rather than inferred: the body returns four differently shaped literals and the two below
	// return two more, and pinning the type is what makes them all one answer rather than a union.
	return panelQuery<ArchivePage>(
		"archives:read",
		async (user) => {
			// Unreachable through the type, and checked anyway: `descriptor` arrives from a browser, and
			// a `source` TypeScript was promised is one of two is still whatever was actually sent.
			const permission = PERMISSION_FOR.get(descriptor.source);
			if (permission === undefined) {
				return { rows: [], more: false, error: "That is not a kind of archive this install writes." };
			}
			if (!(await userHolds(user, permission))) {
				await recordSourceRefusal(user, descriptor, permission);
				return { rows: [], more: false, error: REFUSAL_MESSAGE };
			}

			const found = await listArchives(archiveDirectory());
			const archive = found.find((candidate) => matches(candidate, descriptor));
			if (archive === undefined) {
				// The period is not named back: it came from the caller, and a message that echoes what it
				// was handed is a message that says nothing the caller did not already know.
				return { rows: [], more: false, error: "No archive on disk for that period." };
			}

			return readArchive(archive, (opened) => pageOf(opened, descriptor.source, filters));
		},
		{
			refused: () => ({ rows: [], more: false, error: REFUSAL_MESSAGE }),
			failed: () => ({ rows: [], more: false, error: FAILURE_MESSAGE }),
			// The period, not its rows. A copy of what was read inside the record would put the archive
			// back into the database it was moved out of, one page at a time.
			target: { kind: "archive", id: `${descriptor.source}-${descriptor.periodKey}` },
		},
	);
}

/**
 * The sources this caller may see at all.
 *
 * @param user the signed-in account
 * @returns the sources whose permission they hold, in no particular order
 */
async function readableSources(user: PanelUser): Promise<ArchiveSource[]> {
	const readable: ArchiveSource[] = [];
	if (await userHolds(user, "logs:read")) {
		readable.push("logs");
	}
	if (await userHolds(user, "audit:read")) {
		readable.push("audit");
	}
	return readable;
}

/**
 * Orders periods newest first, with the two sources kept apart within a period.
 *
 * `periodKey` is `yyyy-mm` with the month zero-padded (`periodKeyFor`, `lib/archive/period.ts`), so
 * comparing two of them as text puts them in the same order comparing them as dates would. A parse
 * here would be a second reading of a string whose whole shape already answers the question.
 *
 * @param left one period
 * @param right the other
 * @returns the comparison, newest first
 */
function newestFirst(left: ArchivePeriod, right: ArchivePeriod): number {
	return right.periodKey.localeCompare(left.periodKey) || left.source.localeCompare(right.source);
}

/**
 * Whether a listed archive is the one a caller named.
 *
 * @param candidate an archive the directory listing found
 * @param descriptor what the caller asked for
 * @returns true when they are the same period of the same source
 */
function matches(candidate: ArchiveDescriptor, descriptor: ArchiveRef): boolean {
	return candidate.source === descriptor.source && candidate.periodKey === descriptor.periodKey;
}

/**
 * Records a caller being refused an archive whose source they may not read.
 *
 * Written here rather than by the gate, because the gate has already let this call through on
 * `logs:read` — see this module's comment for why the second half of the rule cannot live in the
 * registry. `DENIED` rather than `FAILURE`, deliberately: `/audit` tells those two apart by colour so
 * that a page of refusals reads as somebody probing rather than as an install that is broken, and a
 * refusal filed as a fault would be in the wrong pile on both counts.
 *
 * The action string is the registry id spelled out, which `registry-coverage.test.ts` checks against
 * the registry — this is one of the few rows in `app/` the gate does not write.
 *
 * @param user who was refused
 * @param descriptor the period they asked for
 * @param permission the permission they were missing
 */
async function recordSourceRefusal(user: PanelUser, descriptor: ArchiveRef, permission: string): Promise<void> {
	await recordAudit({
		action: "archives:read",
		outcome: "DENIED",
		actor: userActor(user),
		target: { kind: "archive", id: `${descriptor.source}-${descriptor.periodKey}` },
		detail: { permission },
		provenance: await requestProvenance(await currentSessionId(user.sessionId)),
	});
}

/**
 * Reads one page out of an opened archive.
 *
 * One row more than the page is asked for, and the extra one is dropped: that answers "is there
 * more" from what was already read rather than from a second `COUNT(*)` over a table that has just
 * been decompressed out of a file.
 *
 * @param archive the opened period
 * @param source which table it holds
 * @param filters what to search for, and how far in
 * @returns the page
 */
function pageOf(archive: Database.Database, source: ArchiveSource, filters: ArchivePageFilters): ArchivePage {
	const skip = Math.max(0, Math.trunc(filters.skip ?? 0));
	const search = (filters.search ?? "").trim();
	const take = PAGE_SIZE + 1;

	const rows = source === "logs" ? logRows(archive, search, take, skip) : auditRows(archive, search, take, skip);
	return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE, error: null };
}

/** A log line as the archive stores it — snake-case, because an archive carries the live table's DDL. */
interface StoredLogRow {
	id: string;
	ts: string;
	level: string;
	message: string;
	agent_name: string | null;
}

/** A recorded event as the archive stores it. See {@link StoredLogRow} for the naming. */
interface StoredAuditRow {
	seq: number;
	at: string;
	actor_name: string | null;
	actor_email: string | null;
	actor_kind: string;
	action: string;
	outcome: string;
	target_label: string | null;
	target_id: string | null;
}

/**
 * Reads log lines out of an opened archive, newest first.
 *
 * The search text is bound rather than interpolated, so a `%` an operator types is a wildcard and
 * nothing they type is ever SQL. The `? = ''` arm is what makes an absent search mean "no filter"
 * inside one prepared statement rather than two.
 *
 * @param archive the opened period
 * @param search the free text, already trimmed; empty means no filter
 * @param take how many rows to read
 * @param skip how many to step over first
 * @returns the rows, in the shape the table renders
 */
function logRows(archive: Database.Database, search: string, take: number, skip: number): ArchiveRow[] {
	const like = `%${search}%`;
	const stored = archive
		.prepare(
			`SELECT id, ts, level, message, agent_name FROM log_entries
			 WHERE (? = '' OR message LIKE ? OR level LIKE ? OR agent_name LIKE ?)
			 ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
		)
		.all(search, like, like, like, take, skip) as StoredLogRow[];

	return stored.map((row) => ({
		kind: "logs",
		id: row.id,
		at: row.ts,
		level: row.level,
		message: row.message,
		origin: row.agent_name,
	}));
}

/**
 * Reads recorded events out of an opened archive, newest first.
 *
 * Ordered by `seq` rather than by `at`, which is the order the chain is in: two events recorded in
 * the same millisecond still have an order, and it is the one the hashes were taken over.
 *
 * @param archive the opened period
 * @param search the free text, already trimmed; empty means no filter
 * @param take how many rows to read
 * @param skip how many to step over first
 * @returns the rows, in the shape the table renders
 */
function auditRows(archive: Database.Database, search: string, take: number, skip: number): ArchiveRow[] {
	const like = `%${search}%`;
	const stored = archive
		.prepare(
			`SELECT seq, at, actor_name, actor_email, actor_kind, action, outcome, target_label, target_id
			 FROM audit_events
			 WHERE (? = '' OR action LIKE ? OR actor_name LIKE ? OR actor_email LIKE ? OR target_label LIKE ?)
			 ORDER BY seq DESC LIMIT ? OFFSET ?`,
		)
		.all(search, like, like, like, like, take, skip) as StoredAuditRow[];

	return stored.map((row) => ({
		kind: "audit",
		id: String(row.seq),
		at: row.at,
		// The kind when there is no name, rather than a dash: a row the server wrote about itself is
		// attributed to `SYSTEM`, and that is the answer to "who did this", not a missing value.
		actor: row.actor_name ?? row.actor_email ?? row.actor_kind,
		action: row.action,
		outcome: row.outcome,
		target: row.target_label ?? row.target_id,
	}));
}
