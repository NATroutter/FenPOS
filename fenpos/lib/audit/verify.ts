import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import Database from "better-sqlite3";
import type { PrismaClient } from "@/generated/prisma-audit/client";
import type { ChainedFields } from "@/lib/audit/chain";
import { GENESIS_HASH, hashEvent } from "@/lib/audit/chain";

/**
 * Walking the chain and reporting where it breaks.
 *
 * Read-only, and deliberately so: there is no repair. A chain that fails verification is evidence,
 * and a function that could "fix" it would be a function that could erase the evidence — which is
 * the exact capability the hash chain exists to deny.
 *
 * **The client is passed in rather than imported.** `lib/db.ts` begins with `import "server-only"`,
 * which throws in a plain node process — and `pnpm audit:verify` is a plain node process, run from
 * a shell precisely because the panel is what an attacker holding superuser credentials already
 * has. Taking the client as an argument is what keeps this module reachable from both sides;
 * `scripts/seed-demo-data.ts` builds its own client for the same reason.
 *
 * **Archives are opened here rather than through `lib/archive/read.ts`, for that same reason.** That
 * module begins with `import "server-only"`, so importing it would put this one behind the guard the
 * paragraph above exists to stay outside of — and the CLI is the caller that most needs the archives,
 * because it is the one an operator runs when they have stopped trusting the panel. What that costs is
 * a second place that knows an archive's filename and how to decompress one, kept as small as it can
 * be: {@link auditArchives} and {@link readAuditArchive} below. What it must never cost is a second
 * hash check, and it does not — every row verified anywhere in this file goes through {@link
 * walkSegment}, which is the one row-walk this codebase has.
 *
 * **What this detects:** an edited row (its own hash no longer matches its contents), a removed row
 * (its successor's link no longer matches the row now preceding it), a forged insert, a swept
 * range whose anchor does not match what survived it, and — when an archive directory is given — the
 * same three edits made inside an archive, plus an archive whose newest row is not the one the live
 * anchor names.
 *
 * **What this cannot detect: truncation at the tail.** Deleting the newest rows leaves a shorter
 * chain that verifies perfectly, because nothing inside the table records how long it should be.
 * That is inherent to a self-contained chain rather than a gap in this implementation, and the
 * remedy is state kept where the attacker is not — shipping rows off the box, or recording the tail
 * somewhere else. Neither is in scope here, and pretending otherwise would be worse than saying so.
 *
 * Truncation at the tail *of an archive* is a different matter, and is detected: the live anchor
 * names the newest row that left, so an archive that no longer ends on it is caught by the join.
 */

/** How the chain failed. */
export type ChainBreak =
	/** The row's stored hash does not match a hash recomputed from its own columns. */
	| "hash-mismatch"
	/** The row's `prevHash` does not match the hash of the row before it. */
	| "link-mismatch"
	/** The oldest retained row's `prevHash` does not match what `AuditAnchor` says was swept. */
	| "anchor-mismatch"
	/** The newest archived row is not the row `AuditAnchor` says was the last one archived. */
	| "archive-join-mismatch";

/** The outcome of a walk. */
export type ChainVerification =
	| {
			ok: true;
			/** How many events verified, archived and live together. */
			checked: number;
			/** How many of them were read out of archive files. */
			archived: number;
			/** How many of them were read out of the live database. */
			live: number;
			firstSeq: number | null;
			lastSeq: number | null;
	  }
	| {
			ok: false;
			checked: number;
			brokenAt: number;
			reason: ChainBreak;
			/**
			 * What `seq` alone cannot say, when the break is a disagreement rather than a bad row.
			 *
			 * Set for `archive-join-mismatch`, where the failure is two records naming different events
			 * and an operator needs both of them to work out which side moved. Absent otherwise, because
			 * for the other three the row named by `brokenAt` is the whole of the finding.
			 */
			detail?: string;
	  };

/** What a walk should cover beyond the live database. */
export interface ChainVerifyOptions {
	/**
	 * Where `lib/archive/rotate.ts` has been writing archives.
	 *
	 * Omitted, only the live rows are walked — which still verifies, because the anchor vouches for
	 * everything that left. Given, the archives in it are walked first and the live rows continue from
	 * them, so the answer covers the whole record rather than the part of it still in the database.
	 *
	 * A directory that is not there is read as "nothing has been archived", not as an error: nothing in
	 * this codebase schedules rotation or creates this directory, so an install that has never archived
	 * is the ordinary case and must not make `pnpm audit:verify` fail. The count of archived events in
	 * the result is what distinguishes that from a directory named wrongly.
	 *
	 * **Walking archives assumes no audit row was ever deleted without being archived first, and nothing
	 * enforces that assumption.** Two ordinary arrangements break it, and this code reports both as a
	 * break in the record rather than as a history it cannot verify:
	 *
	 * - **A sweep that ran before archiving began.** The oldest archive's first row then links to a row
	 *   `sweepAuditNow` deleted, and the anchor that recorded that boundary has since been overwritten by
	 *   rotation's own. Nothing on disk says where the oldest archive should start, so {@link
	 *   walkArchives} starts it at genesis and its first row reports `link-mismatch`.
	 * - **A sweep that ran after a rotation** and re-anchored to a live row newer than the last archived
	 *   one — which needs nothing more exotic than retention's cutoff being newer than rotation's
	 *   boundary. The anchor then names a row no archive holds, and {@link joinToAnchor} reports
	 *   `archive-join-mismatch`.
	 *
	 * Neither is reachable on this branch: `archivePeriod` has no production caller, so nothing is found
	 * here and the plain anchor path runs as it always did. But `maybeSweep` in `lib/audit/audit-log.ts`
	 * runs on the way out of every `recordAudit`, so on any install that has been running a while the
	 * anchor has already moved past genesis — which makes the first case above the *default* state the
	 * first time rotation is wired, not a corner of it. **Whoever gives `archivePeriod` a production
	 * caller must reconcile rotation with `maybeSweep` before doing so**, and should give
	 * swept-before-archived a `ChainBreak` of its own: `describeVerification` has exactly one failure
	 * vocabulary and it is an accusation, so reporting "these rows were swept before archiving began"
	 * through it says "the record was changed after it was written". Those are different findings and
	 * this code cannot currently tell them apart.
	 */
	archiveDirectory?: string;
}

/**
 * Rows read per query.
 *
 * The walk is streamed rather than loaded whole: an install that has been running for a year has
 * more audit rows than anything else in the database, and `pnpm audit:verify` must not be the
 * command that runs it out of memory.
 */
const BATCH_SIZE = 500;

/**
 * The reads a walk needs.
 *
 * A structural subset of the audit database's `PrismaClient` rather than the client itself, so the
 * signature says what this does: it reads two tables and writes nothing. Handing a verifier
 * something that could `update` or `delete` an audit row would contradict the whole shape of the
 * record.
 *
 * The audit client, not the application's: `AuditEvent` and `AuditAnchor` live in `audit.db`, so
 * the application's generated client has neither property and passing it here is a type error.
 */
export type AuditChainReader = Pick<PrismaClient, "auditAnchor" | "auditEvent">;

/**
 * Where a walk is, so the next segment can carry on from it.
 *
 * The chain does not restart at a file boundary — an archive's oldest row links to a row in the
 * archive before it, and the live database's oldest row links to a row in the newest archive. This is
 * what is carried across those boundaries so that one walk covers every segment.
 */
interface ChainPosition {
	/** What the next row's `prevHash` must equal. */
	expectedPrevHash: string;
	/** The `seq` the next read starts after. */
	cursor: number;
	/** How many rows have verified, across every segment walked so far. */
	checked: number;
	/** The oldest `seq` verified, or null when nothing has been. */
	firstSeq: number | null;
	/** The newest `seq` verified, or null when nothing has been. */
	lastSeq: number | null;
}

/** What one segment's walk found. */
type SegmentOutcome =
	| { ok: true; position: ChainPosition }
	| { ok: false; checked: number; brokenAt: number; reason: ChainBreak };

/**
 * Walks one segment of the chain: every row a reader has, from a position, in `seq` order.
 *
 * **The only place a stored hash is recomputed.** An archive and the live database are the same rows
 * in different files, so they are checked by the same code — two implementations of this loop would be
 * two opinions about a stored contract, and the day they disagreed one of them would be declaring a
 * genuine archive tampered with no way to tell which.
 *
 * @param events the rows to walk, live or archived; only the `seq > cursor` form of `findMany` is used
 * @param from where to start, and what has already verified
 * @param anchored whether `from.expectedPrevHash` came from an `AuditAnchor` row, which is what tells a
 *   disagreement at this segment's first row apart from a missing row further in
 * @returns the position the next segment resumes from, or the `seq` at which this one broke and how
 */
async function walkSegment(
	events: AuditChainReader["auditEvent"],
	from: ChainPosition,
	anchored: boolean,
): Promise<SegmentOutcome> {
	let { expectedPrevHash, cursor, checked, firstSeq, lastSeq } = from;
	let inSegment = 0;

	for (;;) {
		const rows = await events.findMany({
			where: { seq: { gt: cursor } },
			orderBy: { seq: "asc" },
			take: BATCH_SIZE,
		});

		if (rows.length === 0) {
			return { ok: true, position: { expectedPrevHash, cursor, checked, firstSeq, lastSeq } };
		}

		for (const row of rows) {
			if (row.prevHash !== expectedPrevHash) {
				// Told apart so the report can say what happened rather than only where: an anchor
				// that disagrees with the oldest surviving row is a retention fault or a doctored
				// anchor, while a mismatch further in is a row that is no longer there.
				const reason: ChainBreak = inSegment === 0 && anchored ? "anchor-mismatch" : "link-mismatch";
				return { ok: false, checked, brokenAt: row.seq, reason };
			}

			if (hashEvent(row, row.prevHash) !== row.hash) {
				return { ok: false, checked, brokenAt: row.seq, reason: "hash-mismatch" };
			}

			expectedPrevHash = row.hash;
			firstSeq ??= row.seq;
			lastSeq = row.seq;
			checked++;
			inSegment++;
		}

		cursor = rows[rows.length - 1].seq;
	}
}

/**
 * Verifies the record: the archives first when asked for, then the rows still live.
 *
 * @param db a client for the database to read; the panel passes the shared one, the CLI its own
 * @param options where the archives are, when the walk should cover them too
 * @returns confirmation with the range checked and where its rows came from, or the exact `seq` at
 *   which it breaks and how
 */
export async function verifyAuditChain(
	db: AuditChainReader,
	options: ChainVerifyOptions = {},
): Promise<ChainVerification> {
	// Absent on an install that has never swept or archived, which is not a fault: it means the chain
	// still starts where it started, at genesis.
	const anchor = await db.auditAnchor.findUnique({ where: { id: 1 } });

	let position: ChainPosition = {
		expectedPrevHash: GENESIS_HASH,
		cursor: 0,
		checked: 0,
		firstSeq: null,
		lastSeq: null,
	};

	if (options.archiveDirectory !== undefined) {
		const walked = await walkArchives(options.archiveDirectory, position);
		if (!walked.ok) {
			return { ok: false, checked: walked.checked, brokenAt: walked.brokenAt, reason: walked.reason };
		}
		position = walked.position;
	}

	const archived = position.checked;
	const lastArchived = position.lastSeq;

	if (lastArchived === null) {
		// Nothing archived, either because no directory was given or because none held audit rows. The
		// anchor is then the only account of what preceded the oldest live row.
		position = { ...position, expectedPrevHash: anchor?.hash ?? GENESIS_HASH, cursor: anchor?.seq ?? 0 };
	} else {
		// The join, and the reason this function is not two verifications side by side: each half can be
		// internally perfect while describing a different chain, and the anchor is the only thing that
		// says they are the same one.
		const join = joinToAnchor(position, lastArchived, anchor);
		if (join !== null) {
			return join;
		}
		position = { ...position, cursor: lastArchived };
	}

	const live = await walkSegment(db.auditEvent, position, anchor !== null);
	if (!live.ok) {
		return { ok: false, checked: live.checked, brokenAt: live.brokenAt, reason: live.reason };
	}

	return {
		ok: true,
		checked: live.position.checked,
		archived,
		live: live.position.checked - archived,
		firstSeq: live.position.firstSeq,
		lastSeq: live.position.lastSeq,
	};
}

/**
 * Checks that the archives end on the event the live database says they end on.
 *
 * Without this the two halves are only checked against themselves: an archive whose newest rows were
 * deleted still verifies from its first row to its new last one, and the live rows still verify against
 * an anchor nobody touched. It is the anchor naming a row the archive no longer ends on that gives the
 * deletion away, which is why this compares hashes rather than counting anything.
 *
 * The message names both sides. One hash on its own tells an operator that something disagrees but not
 * which of the two files moved, and the two are not equally easy to replace.
 *
 * @param position where the archive walk finished; its `expectedPrevHash` is the newest archived hash
 * @param lastArchived the newest archived `seq`
 * @param anchor what the live database says was the last event to leave it
 * @returns the failure to report, or null when the halves join
 */
function joinToAnchor(
	position: ChainPosition,
	lastArchived: number,
	anchor: { seq: number; hash: string } | null,
): ChainVerification | null {
	if (anchor === null) {
		return {
			ok: false,
			checked: position.checked,
			brokenAt: lastArchived,
			reason: "archive-join-mismatch",
			detail:
				`The archives end at seq ${lastArchived} (hash ${position.expectedPrevHash}), but the live database ` +
				"has no anchor, so nothing in it records that those events were ever archived.",
		};
	}

	if (position.expectedPrevHash !== anchor.hash) {
		return {
			ok: false,
			checked: position.checked,
			brokenAt: anchor.seq,
			reason: "archive-join-mismatch",
			detail:
				`The archives end at seq ${lastArchived} (hash ${position.expectedPrevHash}), but the anchor names ` +
				`seq ${anchor.seq} (hash ${anchor.hash}) as the last event archived.`,
		};
	}

	return null;
}

/**
 * Walks every audit archive in a directory, oldest period first.
 *
 * Order is the whole of it: each archive continues the one before it, so reading them in any other
 * order breaks a link that is not broken. Period keys are `YYYY-MM`, which sort as text in the order
 * they happened.
 *
 * Each file's walk starts at `seq > 0` rather than at the position's cursor, so every row an archive
 * holds is checked rather than skipped over by a cursor left behind by the file before it.
 *
 * **The oldest archive is walked from genesis, and that is a precondition rather than something checked
 * here.** It holds only while no audit row has ever been deleted without being archived first. An
 * install that swept before it archived reports `link-mismatch` at the oldest archived row, and one that
 * sweeps rows rotation has not archived reports `archive-join-mismatch` — in both cases an accusation
 * where the truthful answer is that the history cannot be verified. {@link ChainVerifyOptions} sets out
 * both modes and what the person who gives `archivePeriod` a production caller has to reconcile first.
 *
 * @param directory where the archives are
 * @param from where the walk stands before the first archive: genesis, on the oldest one
 * @returns the position the live rows resume from, or where an archive broke
 */
async function walkArchives(directory: string, from: ChainPosition): Promise<SegmentOutcome> {
	let position = from;

	for (const archive of auditArchives(directory)) {
		const outcome = await readAuditArchive(archive, (handle) =>
			// The reader the rotation itself verifies through, so an archive is checked in exactly the
			// shape it was checked in before the live rows were deleted in its favour. Its anchor argument
			// is unused here: what precedes this file is the position carried in from the file before it.
			walkSegment(archiveChainReader(handle, null).auditEvent, { ...position, cursor: 0 }, false),
		);

		if (!outcome.ok) {
			return outcome;
		}
		position = outcome.position;
	}

	return { ok: true, position };
}

/** One audit archive on disk, as the walk needs to know it. */
interface AuditArchive {
	/** The period it covers, e.g. `2026-01`; also what the walk sorts on. */
	periodKey: string;
	/** The file, compressed or not. */
	path: string;
	/** Whether it has to be decompressed before SQLite can read it. */
	compressed: boolean;
}

/**
 * Names an audit archive: `audit-<periodKey>.db`, compressed or not.
 *
 * **Wider than `listArchives` in `lib/archive/read.ts`, deliberately.** That one lists only `.db.gz`,
 * because a bare `.db` needs a different read path and it had no test pinning one. A chain walk cannot
 * afford that blind spot: `lib/archive/rotate.ts` leaves exactly this file when compression fails —
 * a complete, verified archive whose rows are in it and nowhere else — and both ways of skipping it are
 * bad. If it is the newest archive, its events are quietly never checked while the anchor still carries
 * the live rows, so the run reports an intact fraction of the record as the record. If another archive
 * follows it, the hole it leaves puts the running hash out of step with the anchor and an intact record
 * is reported as broken, which is the worse of the two.
 *
 * `*.partial` still does not match, and must not: that is an abandoned rotation attempt whose rows are
 * also still live, so reading one would walk the same events twice.
 */
const AUDIT_ARCHIVE_NAME = /^audit-(\d{4}-\d{2})\.db(\.gz)?$/;

/**
 * Finds the audit archives in a directory, oldest period first.
 *
 * A missing directory is an empty list rather than a throw — see {@link ChainVerifyOptions}. Any other
 * failure to read the directory is raised: a directory that cannot be read is not a directory known to
 * hold nothing, and reporting the chain intact because the archives were unreadable would be a lie.
 *
 * At most one file per period. When both a `.db.gz` and its `.db` are present — which is what rotation
 * leaves if compression succeeded and removing the plain file did not — they hold the same rows, so the
 * compressed one is taken and the period is walked once.
 *
 * @param directory where the archives are
 * @returns one entry per archived period, in the order the chain runs through them
 */
function auditArchives(directory: string): AuditArchive[] {
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}

	const byPeriod = new Map<string, AuditArchive>();
	for (const name of names) {
		const match = AUDIT_ARCHIVE_NAME.exec(name);
		if (match === null) {
			continue;
		}

		const [, periodKey, extension] = match;
		const found: AuditArchive = { periodKey, path: join(directory, name), compressed: extension !== undefined };
		const existing = byPeriod.get(periodKey);
		if (existing === undefined || (found.compressed && !existing.compressed)) {
			byPeriod.set(periodKey, found);
		}
	}

	return [...byPeriod.values()].sort((left, right) => left.periodKey.localeCompare(right.periodKey));
}

/**
 * Opens one archive read-only and runs a query against it.
 *
 * A compressed archive is decompressed into `os.tmpdir()` first, because gzip is not seekable and a
 * SQLite handle cannot sit on one — the same reason and the same destination as `readArchive` in
 * `lib/archive/read.ts`, which this cannot call. The temporary file's name carries a fresh
 * `randomUUID()` so two verifications running at once do not decompress into the same path, and it is
 * removed whether the query returns or throws.
 *
 * An uncompressed archive is opened where it lies. Nothing is copied and nothing is written: the handle
 * is read-only, which is the only way this module is allowed to touch a record it exists to check.
 *
 * @param archive the archive to read
 * @param query runs against the open archive; its return value is this function's return value
 * @returns whatever `query` returned
 */
async function readAuditArchive<T>(
	archive: AuditArchive,
	query: (handle: Database.Database) => Promise<T>,
): Promise<T> {
	const path = archive.compressed ? join(tmpdir(), `audit-${archive.periodKey}-${randomUUID()}.db`) : archive.path;

	try {
		if (archive.compressed) {
			await pipeline(createReadStream(archive.path), createGunzip(), createWriteStream(path));
		}

		const handle = new Database(path, { readonly: true, fileMustExist: true });
		try {
			return await query(handle);
		} finally {
			// Before the outer `finally` tries to remove the file: Windows will not remove one with an
			// open handle, and a leaked handle would keep it locked for the rest of the process.
			handle.close();
		}
	} finally {
		if (archive.compressed) {
			rmSync(path, { force: true });
		}
	}
}

/**
 * The chain state an archive is verified against.
 *
 * The same two columns `AuditAnchor` holds, and for the same reason — an archived chain's oldest row
 * links to an event that is not in the file with it — but not read from an `AuditAnchor` row, because
 * an archive has no such table. `lib/archive/rotate.ts` passes the live anchor as it stood before the
 * rows left, which at that moment is exactly what precedes the archive's oldest row.
 */
export interface ArchiveAnchor {
	/** `seq` of the last event swept or archived before this file's oldest row. */
	seq: number;
	/** That event's `hash`, which this file's oldest row's `prevHash` must equal. */
	hash: string;
}

/**
 * An archived audit row exactly as SQLite hands it back.
 *
 * Snake-case because an archive is written with the same DDL as `audit_events`, and `at` as text
 * because that is the encoding `lib/archive/rotate.ts` writes: ISO-8601 with an explicit offset, the
 * same form the live database stores, so reading one back never involves guessing.
 */
interface StoredAuditRow {
	seq: number;
	at: string;
	actor_kind: string;
	actor_user_id: string | null;
	actor_name: string | null;
	actor_email: string | null;
	api_key_id: string | null;
	api_key_name: string | null;
	action: string;
	target_kind: string | null;
	target_id: string | null;
	target_label: string | null;
	outcome: string;
	detail: string | null;
	ip_address: string | null;
	user_agent: string | null;
	session_id: string | null;
	prev_hash: string;
	hash: string;
}

/**
 * Presents an archive file to {@link verifyAuditChain} as though it were the audit database.
 *
 * An archived period has to be checkable, or it is a file nobody can trust and the rotation that made
 * it destroyed the only copy that could be. This is what makes that check the *same* check: rather
 * than a second implementation of the hash walk — which is how two implementations come to disagree
 * about a stored contract — the archive is wrapped in the reads {@link AuditChainReader} names, and
 * the one verifier walks it.
 *
 * Read-only in the same deliberate sense as the rest of this module: the object below implements
 * exactly `auditAnchor.findUnique` and the `seq > cursor` form of `auditEvent.findMany`, which is all
 * the walk calls, and nothing that could write. It is a structural stand-in and not a Prisma client,
 * so it is cast rather than typed into place; anything the walk does not call is absent.
 *
 * **`at` comes back as a `Date`, and that is load-bearing.** It is one of the sixteen fields the hash
 * covers, and `hashEvent` serialises a `Date` through `toISOString` — hand the walk the raw stored
 * string and every row recomputes to a different digest and reads as tampered.
 *
 * @param archive an open handle on an archive file; the caller opens and closes it
 * @param anchor what precedes the archive's oldest row, or null when the archive starts at genesis
 * @returns a reader {@link verifyAuditChain} accepts
 */
export function archiveChainReader(archive: Database.Database, anchor: ArchiveAnchor | null): AuditChainReader {
	const select = archive.prepare("SELECT * FROM audit_events WHERE seq > ? ORDER BY seq ASC LIMIT ?");

	const reader = {
		auditAnchor: {
			findUnique: async (): Promise<ArchiveAnchor | null> => anchor,
		},
		auditEvent: {
			findMany: async (args: { where: { seq: { gt: number } }; take: number }) =>
				(select.all(args.where.seq.gt, args.take) as StoredAuditRow[]).map(fromStored),
		},
	};

	return reader as unknown as AuditChainReader;
}

/**
 * Restores an archived row to the shape the chain was hashed over.
 *
 * The return type is {@link ChainedFields} plus the three chain columns rather than a hand-written
 * list, so a field added to the canonical form is a type error here instead of a row that quietly
 * hashes to something else.
 *
 * @param row the row as stored
 * @returns the same row in the client's naming, with `at` back as a moment
 */
function fromStored(row: StoredAuditRow): ChainedFields & { seq: number; prevHash: string; hash: string } {
	return {
		seq: row.seq,
		at: new Date(row.at),
		actorKind: row.actor_kind,
		actorUserId: row.actor_user_id,
		actorName: row.actor_name,
		actorEmail: row.actor_email,
		apiKeyId: row.api_key_id,
		apiKeyName: row.api_key_name,
		action: row.action,
		targetKind: row.target_kind,
		targetId: row.target_id,
		targetLabel: row.target_label,
		outcome: row.outcome,
		detail: row.detail,
		ipAddress: row.ip_address,
		userAgent: row.user_agent,
		sessionId: row.session_id,
		prevHash: row.prev_hash,
		hash: row.hash,
	};
}

/**
 * Renders a verification result for an operator.
 *
 * Beside the type rather than inside `scripts/audit-verify.ts` so it can be tested without
 * importing a script — importing one runs its `main()`, which would connect and disconnect the
 * shared Prisma client in the middle of a suite.
 *
 * The split between archived and live rows is always stated, including when it is `0 from archives`.
 * That zero is the one thing that distinguishes a verified record from a verified fraction of one: an
 * archive directory that was named wrongly, or one rotation has never written to, reads as a perfectly
 * intact chain otherwise, and nothing else in the output would say which was checked.
 *
 * @param result what the walk found
 * @returns the lines to print
 */
export function describeVerification(result: ChainVerification): string {
	if (result.ok && result.checked === 0) {
		return "There are no audit events to verify.";
	}
	if (result.ok) {
		return (
			`The audit chain is intact: ${result.checked} events verified, seq ${result.firstSeq} through ` +
			`${result.lastSeq} (${result.archived} from archives, ${result.live} live).`
		);
	}
	return [
		`THE AUDIT CHAIN IS BROKEN at seq ${result.brokenAt} (${result.reason}).`,
		...(result.detail === undefined ? [] : [result.detail]),
		`${result.checked} events before it verified.`,
		"",
		"This means the record was changed after it was written. Nothing here can repair it, and",
		`nothing should: seq ${result.brokenAt} is where an investigation starts.`,
	].join("\n");
}
