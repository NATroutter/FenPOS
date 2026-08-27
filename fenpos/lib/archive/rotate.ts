import "server-only";
import { createReadStream, createWriteStream, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import Database from "better-sqlite3";
import { periodKeyFor } from "@/lib/archive/period";
import { removeAuditThrough } from "@/lib/audit/retention";
import { archiveChainReader, verifyAuditChain } from "@/lib/audit/verify";
import { auditDb, logsDb } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Moving a period out of the live window into a file that still holds it.
 *
 * Retention destroys; this does not. `sweepLogsNow` and `sweepAuditNow` delete what has aged out
 * because the live database has to stay a working size, and what they delete is gone. Rotation is the
 * other half of that: the same rows leave the live window, but into a period file that still holds
 * them. It exists so that a period leaving the live window is a move rather than a deletion.
 *
 * **The order is the safety property, and it is the whole of it: write, verify, delete, compress.**
 *
 * 1. Read the rows at or before the boundary from the live database.
 * 2. Create the period file and its table, with the same DDL the live table has.
 * 3. Insert every row, preserving its primary key, its timestamp, and for audit its `seq`, `prevHash`
 *    and `hash` exactly — an archived audit row that differs in any hashed byte reads as tampered.
 * 4. Verify: the archive's row count against what was read, and for audit the hash chain itself,
 *    walked by `verifyAuditChain` over the file.
 * 5. Only then delete those rows from live, by primary key, in one transaction.
 * 6. Compress to `.db.gz` and remove the uncompressed file.
 *
 * A crash or a throw between any two of those leaves rows **duplicated**, never lost. Anything that
 * fails before step 5 leaves the live rows untouched, which is why the directory is not created here:
 * a misconfigured path fails at step 2, where failing is free. If step 6 fails the archive is already
 * complete and the rows are already gone, so the uncompressed file beside it *is* the archive — that
 * is logged and the file is kept rather than deleted.
 *
 * **Nothing schedules this.** There is no timer, no write counter, and no settings key behind it; it
 * runs when something calls it, and at this phase nothing does. Reading an archive back is not here
 * either — this module only writes them.
 *
 * A `better-sqlite3` handle rather than a Prisma client for the archive: a generated client per period
 * file would need its own schema and its own migration history for a file that exists to be read
 * rarely. Columns and encodings are still the live database's, not this module's invention, so a
 * period file is the live table one period smaller rather than a format of its own.
 */

/** Which live database a rotation drains. */
export type ArchiveSource = "logs" | "audit";

/** What one rotation was asked to do. */
export interface ArchiveOptions {
	/** Which live database to drain. */
	source: ArchiveSource;
	/** Rows at or before this moment are archived. */
	before: Date;
	/**
	 * Directory archives are written to.
	 *
	 * Must already exist. Rotation deliberately does not create it: a mistyped path that failed by
	 * creating the directory would archive a period somewhere nobody looks and then delete the live
	 * rows, whereas one that fails to open the file fails at step 2, before anything is removed.
	 */
	directory: string;
}

/** What one rotation did. */
export interface ArchiveOutcome {
	/** The period the archive is named for: the one that ends at `before`, e.g. `2026-01`. */
	periodKey: string;
	/** How many rows moved. Zero is a real answer, and still leaves a file for the period. */
	rows: number;
	/**
	 * The archive on disk — the `.db.gz`, or the uncompressed `.db` when compression failed.
	 *
	 * Either way the rows are in the file this names; a caller that cares which it got can look at the
	 * extension, and the compression failure is logged when it happens.
	 */
	path: string;
}

/**
 * Rows moved per round trip: read from live, inserted into the archive, and deleted from live.
 *
 * Paged rather than loaded whole for the reason `verify.ts` streams its walk: a period of a busy
 * install is the largest set of rows this codebase ever handles at once, and the code that exists to
 * preserve it must not be what runs the process out of memory. It also keeps the delete
 * well inside SQLite's cap on bound parameters in one statement.
 */
const PAGE_SIZE = 500;

/**
 * The `log_entries` DDL, copied from `prisma/migrations-logs`.
 *
 * A copy rather than something derived from the live file, so an archive's shape is decided by code
 * that can be reviewed rather than by whatever the database happened to look like. `rotate.test.ts`
 * compares the two column lists, which is what turns "copied" into "still the same".
 */
const LOG_ENTRIES_DDL = `
CREATE TABLE "log_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "severity" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT NOT NULL,
    "agent_id" TEXT,
    "device_id" TEXT,
    "agent_name" TEXT,
    "device_name" TEXT
);
CREATE INDEX "log_entries_ts_idx" ON "log_entries"("ts");
CREATE INDEX "log_entries_severity_ts_idx" ON "log_entries"("severity", "ts");
CREATE INDEX "log_entries_agent_id_ts_idx" ON "log_entries"("agent_id", "ts");
`;

/**
 * The `audit_events` DDL, copied from `prisma/migrations-audit`.
 *
 * The unique indexes on `prev_hash` and `hash` come with it rather than being dropped as dead weight
 * in a file nobody writes to twice: they are the archive's own statement that no event appears in it
 * more than once, enforced by SQLite rather than promised by this module.
 *
 * `audit_anchor` is deliberately absent. What precedes an archive's oldest row is the live anchor as
 * it stood before the rows left, which the rotation holds in memory while it verifies; storing a copy
 * would be a second opinion about the same boundary.
 */
const AUDIT_EVENTS_DDL = `
CREATE TABLE "audit_events" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_name" TEXT,
    "actor_email" TEXT,
    "api_key_id" TEXT,
    "api_key_name" TEXT,
    "action" TEXT NOT NULL,
    "target_kind" TEXT,
    "target_id" TEXT,
    "target_label" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "session_id" TEXT,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL
);
CREATE UNIQUE INDEX "audit_events_prev_hash_key" ON "audit_events"("prev_hash");
CREATE UNIQUE INDEX "audit_events_hash_key" ON "audit_events"("hash");
CREATE INDEX "audit_events_at_idx" ON "audit_events"("at");
CREATE INDEX "audit_events_action_at_idx" ON "audit_events"("action", "at");
CREATE INDEX "audit_events_actor_user_id_at_idx" ON "audit_events"("actor_user_id", "at");
CREATE INDEX "audit_events_outcome_at_idx" ON "audit_events"("outcome", "at");
`;

/**
 * Archives one period out of one live database, then removes it from live.
 *
 * The ordering this follows, and why nothing may be reordered, is the module comment above.
 *
 * @param options which database, which boundary, and where the file goes
 * @returns the period archived, how many rows moved, and the file they moved into
 * @throws if the archive cannot be written or does not verify — in which case nothing was deleted
 */
export async function archivePeriod(options: ArchiveOptions): Promise<ArchiveOutcome> {
	// The last instant the boundary covers, so a boundary of "the first moment of February" names
	// January rather than the month it is the start of.
	const periodKey = periodKeyFor(new Date(options.before.getTime() - 1));
	const path = join(options.directory, `${options.source}-${periodKey}.db`);

	const rows =
		options.source === "logs" ? await drainLogs(options.before, path) : await drainAudit(options.before, path);

	return { periodKey, rows, path: await compress(path) };
}

/**
 * Creates the period file, fills it, and cleans up after a failure.
 *
 * The refusal to write over an existing archive is the one guard that runs before the file is opened,
 * and it guards the archive rather than the arguments: rotating the same period twice would otherwise
 * append a second copy of the rows into the first archive, or compress over a `.gz` that already held
 * a month.
 *
 * @param path where the uncompressed archive goes
 * @param ddl the table and indexes to create in it
 * @param fill inserts the rows and verifies them; whatever it returns is returned
 * @returns what `fill` returned
 */
async function intoArchive<T>(path: string, ddl: string, fill: (archive: Database.Database) => Promise<T>): Promise<T> {
	if (existsSync(path) || existsSync(`${path}.gz`)) {
		throw new Error(`An archive for this period already exists at ${path}; refusing to write over it.`);
	}

	const archive = new Database(path);
	let filled = false;
	try {
		archive.exec(ddl);
		const result = await fill(archive);
		filled = true;
		return result;
	} finally {
		// Windows will not remove a file with an open handle, so this closes before it removes — and it
		// closes on every path, because a leaked handle keeps the archive locked for the whole process.
		archive.close();
		if (!filled) {
			// Nothing has been deleted from live yet, so this half-written copy holds nothing that is not
			// still in the database. Removing it keeps a retry possible instead of leaving a file that
			// claims to be the period and is not.
			rmSync(path, { force: true });
		}
	}
}

/**
 * Writes a timestamp the way the live databases store one.
 *
 * ISO-8601 with an explicit `+00:00`, which is what Prisma's SQLite adapter writes into `logs.db` and
 * `audit.db` — so a reader never has to guess whether a stored moment was epoch milliseconds, local
 * time, or UTC. For an audit row that is not a nicety: `at` is one of the sixteen fields the hash
 * covers, and a moment that does not come back as the same moment recomputes to a different digest.
 *
 * @param at the moment to store
 * @returns its stored form
 */
function storedAt(at: Date): string {
	return at.toISOString().replace("Z", "+00:00");
}

/**
 * Moves log lines at or before the boundary into the archive.
 *
 * Live rows are deleted by the ids collected while writing, not by repeating the timestamp predicate:
 * a line written between the read and the delete would match that predicate without being in the
 * archive, and would then be the one row this whole module exists to not lose.
 *
 * @param before rows at or before this moment
 * @param path where the uncompressed archive goes
 * @returns how many lines were archived
 */
async function drainLogs(before: Date, path: string): Promise<number> {
	const archived = await intoArchive(path, LOG_ENTRIES_DDL, async (archive) => {
		const insert = archive.prepare(
			`INSERT INTO log_entries (id, ts, level, severity, message, agent_id, device_id, agent_name, device_name)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const ids: string[] = [];

		let cursor = "";
		for (;;) {
			const page = await logsDb.logEntry.findMany({
				where: { ts: { lte: before }, id: { gt: cursor } },
				orderBy: { id: "asc" },
				take: PAGE_SIZE,
			});
			if (page.length === 0) {
				break;
			}

			archive.transaction(() => {
				for (const row of page) {
					insert.run(
						row.id,
						storedAt(row.ts),
						row.level,
						row.severity,
						row.message,
						row.agentId,
						row.deviceId,
						row.agentName,
						row.deviceName,
					);
				}
			})();

			for (const row of page) {
				ids.push(row.id);
			}
			cursor = page[page.length - 1].id;
		}

		const { rows } = archive.prepare("SELECT COUNT(*) AS rows FROM log_entries").get() as { rows: number };
		if (rows !== ids.length) {
			throw new Error(`The archive holds ${rows} log lines but ${ids.length} were read; refusing to delete.`);
		}
		return ids;
	});

	await logsDb.$transaction(async (tx) => {
		// Batched because SQLite caps the number of bound parameters in one statement, and a period can
		// hold far more rows than that cap. One transaction around the batches is what keeps the delete
		// all-or-nothing anyway.
		for (let start = 0; start < archived.length; start += PAGE_SIZE) {
			await tx.logEntry.deleteMany({ where: { id: { in: archived.slice(start, start + PAGE_SIZE) } } });
		}
	});

	return archived.length;
}

/**
 * Moves the front of the audit chain, up to the boundary, into the archive.
 *
 * **Selected by `seq`, not by the timestamp predicate, and that is deliberate.** The boundary is the
 * newest `seq` whose `at` is within range, and everything up to it goes — so the set archived and the
 * set deleted are the same set by construction rather than by two queries agreeing. It is also the
 * only shape the chain permits: an anchor vouches for exactly one boundary, so what leaves has to be a
 * prefix, and a gap anywhere else could never be told from a removed row.
 *
 * @param before rows at or before this moment
 * @param path where the uncompressed archive goes
 * @returns how many events were archived
 */
async function drainAudit(before: Date, path: string): Promise<number> {
	const newest = await auditDb.auditEvent.findFirst({
		where: { at: { lte: before } },
		orderBy: { seq: "desc" },
		select: { seq: true },
	});
	const boundary = newest?.seq ?? 0;

	// Read before the delete, because it is what the delete replaces: at this moment the anchor names
	// the event immediately before the archive's oldest row, which is exactly what that row's
	// `prevHash` must equal for the archive to verify as a continuation of everything already swept.
	const anchor = await auditDb.auditAnchor.findUnique({ where: { id: 1 }, select: { seq: true, hash: true } });

	const archived = await intoArchive(path, AUDIT_EVENTS_DDL, async (archive) => {
		const insert = archive.prepare(
			`INSERT INTO audit_events (seq, at, actor_kind, actor_user_id, actor_name, actor_email, api_key_id,
			 api_key_name, action, target_kind, target_id, target_label, outcome, detail, ip_address, user_agent,
			 session_id, prev_hash, hash)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		let count = 0;

		let cursor = 0;
		while (cursor < boundary) {
			const page = await auditDb.auditEvent.findMany({
				where: { seq: { gt: cursor, lte: boundary } },
				orderBy: { seq: "asc" },
				take: PAGE_SIZE,
			});
			if (page.length === 0) {
				break;
			}

			archive.transaction(() => {
				for (const row of page) {
					insert.run(
						row.seq,
						storedAt(row.at),
						row.actorKind,
						row.actorUserId,
						row.actorName,
						row.actorEmail,
						row.apiKeyId,
						row.apiKeyName,
						row.action,
						row.targetKind,
						row.targetId,
						row.targetLabel,
						row.outcome,
						row.detail,
						row.ipAddress,
						row.userAgent,
						row.sessionId,
						row.prevHash,
						row.hash,
					);
				}
			})();

			count += page.length;
			cursor = page[page.length - 1].seq;
		}

		const { rows } = archive.prepare("SELECT COUNT(*) AS rows FROM audit_events").get() as { rows: number };
		if (rows !== count) {
			throw new Error(`The archive holds ${rows} audit events but ${count} were read; refusing to delete.`);
		}

		// The same walk the panel and `pnpm audit:verify` run, over the file rather than the database —
		// see `archiveChainReader`. An archive that does not verify is not one the live rows may be
		// deleted in favour of, whether the chain was already broken or the copy went wrong.
		const verified = await verifyAuditChain(archiveChainReader(archive, anchor));
		if (!verified.ok) {
			throw new Error(
				`The archived audit chain does not verify: ${verified.reason} at seq ${verified.brokenAt}; refusing to delete.`,
			);
		}
		return count;
	});

	// The anchor is written by the one piece of code that knows how, and it removes exactly the prefix
	// that was archived — the same `boundary` both sides were selected by.
	await removeAuditThrough(boundary);

	return archived;
}

/**
 * Compresses a finished archive and removes the uncompressed file.
 *
 * Step 6, and the only step that runs after the live rows are gone — so it must not be able to lose
 * them. A failure here leaves a complete, uncompressed archive on disk, which is the same rows in a
 * larger file; that is logged and kept rather than retried or removed, because removing it is the one
 * action that would turn a disk-space problem into a lost period.
 *
 * @param path the uncompressed archive
 * @returns the compressed file, or `path` itself when compression failed
 */
async function compress(path: string): Promise<string> {
	const compressed = `${path}.gz`;

	try {
		await pipeline(createReadStream(path), createGzip(), createWriteStream(compressed));
	} catch (error) {
		logger.error("Could not compress an archive; the uncompressed file beside it is the archive", error, { path });
		return path;
	}

	try {
		rmSync(path, { force: true });
	} catch (error) {
		logger.error("Could not remove an archive after compressing it; both copies are on disk", error, { path });
	}

	return compressed;
}
