"use server";

import { rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { revalidatePath } from "next/cache";
import { type ArchiveDescriptor, listArchives, readArchive } from "@/lib/archive/read";
import type { ArchiveSource } from "@/lib/archive/rotate";
import { recordAudit, userActor } from "@/lib/audit/audit-log";
import { advanceEpoch } from "@/lib/audit/epoch";
import { requestProvenance } from "@/lib/audit/provenance";
import { userHolds } from "@/lib/auth/effective-permissions";
import { panelAction, panelSelf } from "@/lib/auth/panel-action";
import type { PanelActionId } from "@/lib/auth/panel-actions";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import { currentSessionId, type PanelUser } from "@/lib/auth/require-session";
import type { PanelPermission } from "@/lib/domain/panel-permissions";
import { ApiError } from "@/lib/errors";
import { archiveDirectory } from "@/lib/maintenance/pass";
import type { ActionState } from "@/lib/panel/action-state";

/**
 * Server actions behind the Archives tab.
 *
 * An archive nobody can read is storage, not a record. Everything else on this branch moves whole
 * periods out of the live databases and into `<source>-<period>.db.gz`; the two reads here are what
 * turn that from "the rows are gone" into "the rows are over here".
 *
 * **Opened on demand, never on page load.** {@link listArchivePeriods} reads a directory listing and
 * a size per file, which is cheap and safe to do while rendering. {@link readArchivePage}
 * decompresses a whole period into a temporary file and opens SQLite on it, which on a busy install's
 * month is the most expensive read the panel can perform — so it runs when somebody asks for a
 * period, and never as a side effect of arriving at the tab.
 *
 * **The two reads take no new permission, and no gate could name one for them.** An archive is the
 * same data through a different file, so a log period is `logs:read` and an audit period is
 * `audit:read` — and which of those governs a call is decided by the call's own argument. A registry
 * entry names one permission, so any string written there would be wrong for one of the two sources
 * and would lock that source's readers out of the tab. Both are registered `custom` for exactly that
 * reason, which is the kind's stated purpose, and both check per source here.
 *
 * **Registered `custom` means those two owe their own audit rows, and they pay it.** A refusal is
 * written as `DENIED` naming the permission the caller was missing, so permission probing stays
 * visible; a broken archive directory is written as `FAILURE`. Success is deliberately not recorded:
 * arriving at the tab lists, and an operator hunting through a period opens it over and over, so a row
 * per success would bury the rows worth reading. That is the argument `query` makes, kept even though
 * the kind could not be. {@link record} encodes it — it does not accept `SUCCESS`.
 *
 * **Neither of those two removes anything; {@link deleteAuditArchive} does, and it is shaped nothing
 * like them.** Log archives are pruned by age by `pruneLogArchives` on the maintenance pass. Audit
 * archives never are, because they are evidence — so an operator who needs the space removes one
 * deliberately, under `audit:archive-delete` and nothing else, and the epoch moves with the file in the
 * same call. Having exactly one governing permission is what lets it be an ordinary `command`, gate and
 * audit row and all, rather than another `custom` entry checking itself.
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
 * What the listing hands back.
 *
 * A result rather than a bare array, and that is the whole point of the shape: on a directory the
 * server cannot read, an empty array renders as "nothing has been archived yet" — a positive claim
 * about the record, made on the one page whose job is telling an operator where the record went. The
 * periods and the reason the list may be short travel together so the page cannot state one without
 * the other.
 */
export interface ArchiveListing {
	/** Every readable period found, newest first. */
	periods: ArchivePeriod[];
	/** Why {@link periods} is not what is on disk, when it is not. Null when it is. */
	error: string | null;
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

/** What a read that broke rather than one that was refused tells the operator. */
const READ_FAILURE_MESSAGE = "The archive could not be read. Check the server log.";

/**
 * What a listing that broke tells the operator.
 *
 * Says the list is untrustworthy rather than merely that something failed, because the empty table it
 * accompanies would otherwise read as an answer.
 */
const LIST_FAILURE_MESSAGE =
	"The archive directory could not be read, so this is not what is on disk. Check the server log.";

/**
 * A period key that is not one, said once for the two actions that check for it.
 *
 * Both {@link readArchivePage} and {@link deleteAuditArchive} refuse a key that is not `yyyy-mm`, and
 * two spellings of one sentence is how they come to differ by a word nobody meant to change.
 */
const NOT_A_PERIOD_MESSAGE = "That is not an archive period.";

/**
 * The four ways {@link deleteAuditArchive} refuses a period it will not remove.
 *
 * All four are raised as `invalid_type`, as is {@link NOT_A_PERIOD_MESSAGE} — the code every other
 * panel action reaches for when an argument names something it cannot act on. None of them ever
 * reaches the public API, because a server action is not an endpoint, so the code here does one job:
 * it tells {@link panelAction} that this is a message written to be read rather than an internal
 * failure it must replace. Inventing a code for a refusal that exists solely in the panel would widen
 * a contract clients branch on, for nothing.
 */
const NO_SUCH_ARCHIVE_MESSAGE = "No archive on disk for that audit period.";

/** See {@link NO_SUCH_ARCHIVE_MESSAGE}. */
const NEWEST_ARCHIVE_MESSAGE =
	"The newest audit archive cannot be deleted: the live record links back to it, and nothing " +
	"else can vouch for that join.";

/** See {@link NO_SUCH_ARCHIVE_MESSAGE}. */
const OLDER_ARCHIVE_FIRST_MESSAGE =
	"Only the oldest audit archive can be deleted. Removing one from the middle would leave the " +
	"archive after it linking to a file that is gone.";

/** See {@link NO_SUCH_ARCHIVE_MESSAGE}. */
const NO_NEW_BEGINNING_MESSAGE =
	"The next audit archive holds no events, so there is nowhere for the record to begin from.";

/**
 * The two registry ids this module writes rows under.
 *
 * `Extract` rather than a hand-written union: if either id is renamed in the registry the type
 * collapses to `never` and every call below stops compiling, which is a stronger guarantee than
 * `registry-coverage.test.ts`'s scan for written literals could give — that scan reads string
 * literals, and these rows are written from a variable.
 */
type ArchiveActionId = Extract<PanelActionId, "archives:list" | "archives:read">;

/** A source a caller named, resolved to the source itself and the permission that governs it. */
interface NamedSource {
	source: ArchiveSource;
	permission: PanelPermission;
}

/**
 * Every archive source, and the existing permission each is read under.
 *
 * A `Map` rather than a record literal, so a `source` arriving off the wire is *looked up* rather
 * than used as an index — `"__proto__" in someObject` is true and `someObject["__proto__"]` answers,
 * whereas a `Map` returns `undefined` for every key nothing put in it.
 */
const ARCHIVE_SOURCES = new Map<string, NamedSource>([
	["logs", { source: "logs", permission: "logs:read" }],
	["audit", { source: "audit", permission: "audit:read" }],
]);

/** Every permission that governs any archive, derived rather than spelled a second time. */
const ARCHIVE_PERMISSIONS: readonly PanelPermission[] = [...ARCHIVE_SOURCES.values()].map((named) => named.permission);

/** The shape `periodKeyFor` writes, and so the only shape a listed archive can ever carry. */
const PERIOD_KEY = /^\d{4}-\d{2}$/;

/** An archive a caller asked for, once its fields have been checked rather than assumed. */
interface AskedArchive extends NamedSource {
	periodKey: string;
}

/**
 * Lists the periods on disk that this caller may read.
 *
 * Newest first, because the period somebody has come looking for is almost always the one that has
 * just aged out. `listArchives` promises no order at all — it returns the directory in whatever order
 * the filesystem gave it, which interleaves the two sources by filename at best — so the ordering is
 * put on here rather than relied on from there.
 *
 * A caller holding one permission and not the other is shown that source's periods and not the
 * other's, rather than being refused: which months of the audit record exist is itself something
 * `audit:read` governs, and the same in reverse. Only a caller holding neither is refused.
 *
 * @returns the readable periods newest first, and the reason that list is short when there is one
 */
export async function listArchivePeriods(): Promise<ArchiveListing> {
	// Outside any try: an absent session redirects, and `redirect` signals by throwing.
	const user = await panelSelf("archives:list");

	const readable = await readableSources(user);
	if (readable.length === 0) {
		await record("archives:list", user, "DENIED", { permission: ARCHIVE_PERMISSIONS });
		return { periods: [], error: REFUSAL_MESSAGE };
	}

	try {
		const found = await listArchives(archiveDirectory());
		const periods = found
			.filter((archive) => readable.includes(archive.source))
			.map((archive) => ({ periodKey: archive.periodKey, source: archive.source, bytes: archive.bytes }))
			.sort(newestFirst);
		return { periods, error: null };
	} catch (error) {
		// `archiveDirectory()` creates the directory recursively, so "it is not there" heals itself and
		// what is left is a volume the server cannot read or a path that is not a directory — narrow, and
		// exactly the case an operator most needs told about rather than shown an empty table for.
		await record("archives:list", user, "FAILURE", { error: messageOf(error) });
		return { periods: [], error: LIST_FAILURE_MESSAGE };
	}
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
 * **The refusal comes before the directory is read.** A caller who may not read this source learns
 * nothing about which periods exist, because nothing has looked yet.
 *
 * @param descriptor which period to open, named rather than pathed
 * @param filters what to search for, and how far in
 * @returns the page, or the reason there is none
 */
export async function readArchivePage(descriptor: ArchiveRef, filters: ArchivePageFilters): Promise<ArchivePage> {
	// Outside any try, and before anything reads `descriptor`: an absent session redirects by throwing,
	// and a malformed argument must not be able to fail ahead of the session being resolved — that
	// would make the one call this module never records the hostile one.
	const user = await panelSelf("archives:read");

	// Held outside the try so the failure row can still name what was asked for, when that much was
	// legible. Null while it is not.
	let asked: AskedArchive | null = null;

	try {
		// A `const` as well as the outer `let`, and not only for tidiness: the `find` below closes over
		// it, and TypeScript will not narrow a `let` across a function boundary.
		const named = askedArchive(descriptor);
		asked = named;

		if (!(await userHolds(user, named.permission))) {
			await record("archives:read", user, "DENIED", { permission: named.permission }, targetOf(named));
			return { rows: [], more: false, error: REFUSAL_MESSAGE };
		}

		const found = await listArchives(archiveDirectory());
		const archive = found.find((candidate) => matches(candidate, named));
		if (archive === undefined) {
			// The period is not named back: it came from the caller, and a message that echoes what it
			// was handed is a message that says nothing the caller did not already know.
			return { rows: [], more: false, error: "No archive on disk for that period." };
		}

		return await readArchive(archive, (opened) => pageOf(opened, archive.source, filters));
	} catch (error) {
		await record(
			"archives:read",
			user,
			"FAILURE",
			{ error: messageOf(error) },
			asked === null ? undefined : targetOf(asked),
		);
		// An `ApiError` carries a message written to be read — a malformed descriptor's, here. Anything
		// else is unexpected and reported generically, because an internal message in a panel is at best
		// noise and at worst a disclosure.
		return { rows: [], more: false, error: error instanceof ApiError ? error.message : READ_FAILURE_MESSAGE };
	}
}

/**
 * Deletes one archived audit period, and moves the epoch behind it in the same call.
 *
 * The only path that removes an audit archive. Nothing on a timer does: log archives age out because
 * they are output, and audit archives do not because they are evidence — so this is a person deciding
 * they need the space, gated by a permission of its own and written into the record it shortens.
 *
 * **The epoch moves with the file, or the file does not move.** `AuditEpoch` is what says how far back
 * the archives should reach; leaving it naming a period that is gone makes the next verification report
 * `archive-missing`, which accuses the operator of losing evidence they deliberately removed. That is
 * the same false accusation the epoch exists to prevent, arriving from the other end.
 *
 * @param periodKey the audit period to remove, e.g. `2026-01`
 * @returns the state to render
 */
export async function deleteAuditArchive(periodKey: string): Promise<ActionState> {
	// Read before the gate runs, and only far enough to decide whether the row may name it: `target`
	// has to be built here, and a key that has not been checked is a caller writing whatever they like
	// into the audit record. The body checks it again and refuses — this only decides whether there is
	// a period worth naming in the row.
	const named = typeof periodKey === "string" && PERIOD_KEY.test(periodKey);

	return panelAction("audit:archive-delete", () => removeAuditArchive(periodKey), {
		revalidate: () => revalidatePath("/archives"),
		target: named ? targetOf({ source: "audit", periodKey }) : undefined,
	});
}

/**
 * Removes the file and advances the epoch, having established that this period is the one that may go.
 *
 * **Only a prefix may go, and never the whole of it.** Removing from the newest end would leave the
 * live rows linking to an archived row that no longer exists, and removing from the middle would leave
 * the archive after the hole doing the same — neither is something the epoch can describe, because the
 * epoch says where the record begins and not where it is interrupted. Refusing the newest is also what
 * keeps the last archive on disk: with none left, an epoch reports `archive-missing` and no epoch at
 * all reports the surviving live rows as though they were the whole record, and there is no third
 * answer that is true.
 *
 * **Order matters at every step.** The period that will become the oldest is read *before* anything is
 * deleted, so an archive whose first row cannot be read costs nothing rather than leaving an epoch with
 * nowhere to point. The file then goes before the epoch moves: a crash in that window leaves an
 * `archive-missing` naming the file that is genuinely no longer there, beside the row saying who took
 * it, where the other order would leave the surviving archives read against an epoch they do not start
 * on and report tampering instead.
 *
 * @param periodKey the audit period named by the caller, still unchecked
 * @throws ApiError when the key is unreadable, names no audit archive, or names one that may not go
 */
async function removeAuditArchive(periodKey: string): Promise<void> {
	if (typeof periodKey !== "string" || !PERIOD_KEY.test(periodKey)) {
		throw new ApiError("invalid_type", NOT_A_PERIOD_MESSAGE);
	}

	// Audit only, and oldest first. `listArchives` promises no order at all, and both checks below are
	// about position — an unordered list would make "the oldest" whichever file the directory happened
	// to hand back first.
	const archives = (await listArchives(archiveDirectory()))
		.filter((archive) => archive.source === "audit")
		.sort((left, right) => left.periodKey.localeCompare(right.periodKey));

	const index = archives.findIndex((archive) => archive.periodKey === periodKey);
	if (index === -1) {
		throw new ApiError("invalid_type", NO_SUCH_ARCHIVE_MESSAGE);
	}
	// Before the oldest check, so the one archive on disk — which is both — is refused as the newest.
	// That is the honest reading: what makes it undeletable is the live record hanging off it.
	if (index === archives.length - 1) {
		throw new ApiError("invalid_type", NEWEST_ARCHIVE_MESSAGE);
	}
	if (index !== 0) {
		throw new ApiError("invalid_type", OLDER_ARCHIVE_FIRST_MESSAGE);
	}

	const begins = await oldestArchivedEvent(archives[1]);

	rmSync(archives[0].path, { force: true });
	await advanceEpoch(begins.seq, begins.prevHash);
}

/**
 * Reads the row an archive's chain starts on.
 *
 * Exactly what the epoch records: the oldest archived `seq` and the hash it links back to, which is
 * what `verifyAuditChain` walks the oldest archive from. Read out of the file rather than derived from
 * anything the caller said, because the file is what the walk will actually open.
 *
 * @param archive the period that is about to become the oldest on disk
 * @returns the `seq` and `prevHash` of its first event
 * @throws ApiError when it holds no events at all
 */
async function oldestArchivedEvent(archive: ArchiveDescriptor): Promise<{ seq: number; prevHash: string }> {
	const row = await readArchive(
		archive,
		(opened) =>
			opened.prepare("SELECT seq, prev_hash AS prevHash FROM audit_events ORDER BY seq ASC LIMIT 1").get() as
				| { seq: number; prevHash: string }
				| undefined,
	);

	if (row === undefined) {
		throw new ApiError("invalid_type", NO_NEW_BEGINNING_MESSAGE);
	}
	return row;
}

/**
 * Reads a caller's descriptor, checking every field rather than trusting the type on it.
 *
 * A server action's arguments are whatever was posted to it. TypeScript says this is an
 * {@link ArchiveRef}; the wire says nothing of the kind, and dereferencing `descriptor.source` on a
 * `null` would throw a raw `TypeError` out of an action that had not yet decided whether to record
 * anything.
 *
 * `periodKey` is held to `yyyy-mm` even though it is only ever compared for equality afterwards. A key
 * of another shape could never match a listed archive, so refusing it changes no legitimate answer —
 * and it bounds what a caller can put into the `target` of an audit row at seven characters.
 *
 * @param descriptor the argument, as it arrived
 * @returns the source, the permission governing it, and the period asked for
 * @throws ApiError when any field is missing, of the wrong type, or names something this install does
 *   not write
 */
function askedArchive(descriptor: ArchiveRef): AskedArchive {
	const value: unknown = descriptor;
	if (typeof value !== "object" || value === null) {
		throw new ApiError("invalid_type", "That is not an archive.");
	}

	const { source, periodKey } = value as { source?: unknown; periodKey?: unknown };
	const named = typeof source === "string" ? ARCHIVE_SOURCES.get(source) : undefined;
	if (named === undefined) {
		throw new ApiError("invalid_type", "That is not a kind of archive this install writes.");
	}
	if (typeof periodKey !== "string" || !PERIOD_KEY.test(periodKey)) {
		throw new ApiError("invalid_type", NOT_A_PERIOD_MESSAGE);
	}

	return { ...named, periodKey };
}

/**
 * The sources this caller may see at all.
 *
 * @param user the signed-in account
 * @returns the sources whose permission they hold, in no particular order
 */
async function readableSources(user: PanelUser): Promise<ArchiveSource[]> {
	const readable: ArchiveSource[] = [];
	for (const named of ARCHIVE_SOURCES.values()) {
		if (await userHolds(user, named.permission)) {
			readable.push(named.source);
		}
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
 * @param asked what the caller asked for, already checked
 * @returns true when they are the same period of the same source
 */
function matches(candidate: ArchiveDescriptor, asked: AskedArchive): boolean {
	return candidate.source === asked.source && candidate.periodKey === asked.periodKey;
}

/**
 * What an audit row names when one of these actions is about a particular period.
 *
 * Takes the two fields it reads rather than an {@link AskedArchive}, so the delete — which resolves no
 * permission, because its own is the only one — can name its period the same way the reads name theirs.
 *
 * @param asked the period the call was about, its source and key already checked
 * @returns the row's target
 */
function targetOf(asked: { source: ArchiveSource; periodKey: string }): { kind: string; id: string } {
	return { kind: "archive", id: `${asked.source}-${asked.periodKey}` };
}

/**
 * Writes the audit row one of these actions owes.
 *
 * `outcome` deliberately excludes `SUCCESS`, so "these two are silent about working" is a fact the
 * type carries rather than a habit the next reader has to notice. The module comment above says why.
 *
 * The session id is read fresh through {@link currentSessionId} for the reason `panel-action.ts`'s
 * own `record()` gives; neither of these actions rotates a session, so it reads back what the gate
 * was already carrying.
 *
 * @param id which action, which is also what the row's `action` says
 * @param user who was acting
 * @param outcome how it went
 * @param detail the named fields for the row
 * @param target what it was about, when it was about one period
 */
async function record(
	id: ArchiveActionId,
	user: PanelUser,
	outcome: "DENIED" | "FAILURE",
	detail: Record<string, unknown>,
	target?: { kind: string; id: string },
): Promise<void> {
	await recordAudit({
		action: id,
		outcome,
		actor: userActor(user),
		target,
		detail,
		provenance: await requestProvenance(await currentSessionId(user.sessionId)),
	});
}

/**
 * @param error whatever was thrown
 * @returns what to put in the audit row's `error` field
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	// Clamped rather than trusted: `skip` crosses the wire, and a negative or fractional one is a
	// SQLite `OFFSET` that either errors or silently means something else.
	const skip = Math.max(0, Math.trunc(Number(filters.skip ?? 0)) || 0);
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
