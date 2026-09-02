import "server-only";
import { mkdirSync } from "node:fs";
import { pruneLogArchives } from "@/lib/archive/prune";
import { appendEvent, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { sweepAuditNow } from "@/lib/audit/retention";
import { AUDIT_SWEEP_ACTION } from "@/lib/audit/system-actions";
import { auditDb, metricsDb, prisma } from "@/lib/db";
import { AUDIT_ARCHIVE_DIRECTORY } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sweepLogsNow } from "@/lib/logs/retention";
import { runMetricsRollup } from "@/lib/metrics/rollup";
import { globalAuditSettings, globalLogIngestSettings, globalStatsSettings } from "@/lib/settings/settings-service";

/**
 * The recurring work that keeps both record databases inside their windows.
 *
 * Retention used to run on the way out of a write — `maybeSweep` after every recorded audit event,
 * `sweepOccasionally` every *n*th log line. It cannot any more: a sweep now archives before it
 * deletes, which means opening a database, copying a period, verifying it and gzipping, and none of
 * that belongs in front of a print request.
 *
 * Moving it here fixes something the write-path version could not do at all: an install that stops
 * writing now still sweeps, where before it would sit at whatever size it had reached.
 *
 * **The sweep's bounds are read from the application database.** `audit.retentionDays` lives in
 * `fenpos.db` while the record it bounds lives in `audit.db`, so an unreadable `fenpos.db` leaves the
 * record unswept and growing — reported by the guard below and otherwise ignored, because a sweep
 * that cannot read its own bounds must not become the reason nothing else runs either.
 *
 * **Never throws.** The interval that drives this has nobody above it to catch a rejection, and an
 * unhandled one takes the process down — which, under `compose.yaml`'s `restart: unless-stopped`, is
 * a crash loop rather than an error. Each half is guarded separately so a broken `logs.db` cannot
 * stop the audit record being swept.
 */

/**
 * Where archives are written, created if it is not there yet.
 *
 * The rule itself — a sibling `archives` directory next to the *audit* database's resolved URL — is
 * `AUDIT_ARCHIVE_DIRECTORY`'s (`lib/env.ts`), and is consumed here rather than repeated: a second
 * derivation is how rotation and verification end up looking in different directories, and that
 * mismatch is silent — its only symptom is a chain reporting no archives at all.
 *
 * A function rather than a re-export because of the `mkdirSync`, which must not run at module load:
 * importing this module would otherwise create a directory as a side effect, in a test run or a
 * `next build` as readily as in a server. Creating it at all is this module's job precisely because
 * `archivePeriod` refuses to — a mistyped path there must fail before any row is deleted, which
 * leaves somebody having to provision the one path that is not a guess.
 *
 * @returns the archive directory's absolute path
 */
export function archiveDirectory(): string {
	mkdirSync(AUDIT_ARCHIVE_DIRECTORY, { recursive: true });
	return AUDIT_ARCHIVE_DIRECTORY;
}

/**
 * Runs one pass of retention over both databases.
 *
 * @returns when both halves have been attempted, whether or not either succeeded
 */
export async function runMaintenancePass(): Promise<void> {
	try {
		// Inside the guard, not above both of them: `mkdirSync` throws on a read-only volume or a path
		// that is already a file, and a pass that threw there would be a pass that broke its own promise
		// before either half had started. Called once per half rather than once per pass for that reason
		// alone; it is one idempotent syscall.
		const directory = archiveDirectory();
		const { retentionDays, archiveEnabled, archiveRetentionDays } = await globalLogIngestSettings();
		const { removed } = await sweepLogsNow(retentionDays, { archiveEnabled, archiveDirectory: directory });
		if (removed > 0) {
			logger.info("Swept log lines past the retention window", { removed });
		}

		// Bulk and bounded by their own setting, never the audit half's: a log archive is deleted once
		// its period ages past `archiveRetentionDays`, but an audit archive is deleted only by the panel
		// action that advances the epoch alongside it (Task 13) — see `pruneLogArchives`'s doc comment
		// for why a timer must never be the thing that moves that epoch.
		const { removed: prunedArchives } = await pruneLogArchives(directory, archiveRetentionDays);
		if (prunedArchives.length > 0) {
			logger.info("Deleted log archives past their retention window", { removed: prunedArchives });
		}
	} catch (error) {
		// Reported rather than swallowed quietly, and this is the reason `periodsFullyBefore` refuses an
		// invalid `Date` instead of absorbing it: nobody is watching an hourly timer, so a corrupt
		// setting has to cost one visible, named failure rather than a sweep that quietly never happens.
		logger.error("A log retention pass could not run", error);
	}

	try {
		const directory = archiveDirectory();
		const { retentionDays } = await globalAuditSettings();
		const outcome = await sweepAuditNow({ retentionDays }, { archiveDirectory: directory });
		if (outcome) {
			logger.info("Archived audit events past the retention window", {
				removed: outcome.removed,
				anchoredAt: outcome.anchoredAt,
			});
			// The record also says what happened to it, in itself — `audit:sweep` is the one action the
			// record writes about its own deletions, and `/audit` offers it as a filter. Written through
			// `appendEvent` rather than `recordAudit` for no reason beyond it being the writer this module
			// already needs; the two are the same call now that recording an event triggers nothing.
			await appendEvent({
				action: AUDIT_SWEEP_ACTION,
				outcome: "SUCCESS",
				actor: SYSTEM_ACTOR,
				detail: { removed: outcome.removed, anchoredAt: outcome.anchoredAt, retentionDays },
			});
		}
	} catch (error) {
		logger.error("An audit retention pass could not run", error);
	}

	try {
		const stats = await globalStatsSettings();
		if (stats.enabled) {
			const { rolledHours } = await runMetricsRollup({ db: prisma, metricsDb, auditDb });
			if (rolledHours > 0) {
				logger.info("Rolled hourly metrics", { rolledHours });
			}
			const cutoff = new Date(Date.now() - stats.sampleRetentionDays * 24 * 60 * 60 * 1000);
			const { count } = await metricsDb.fleetSample.deleteMany({ where: { at: { lt: cutoff } } });
			if (count > 0) {
				logger.info("Pruned fleet samples past the retention window", { count });
			}
		}
	} catch (error) {
		logger.error("A metrics rollup pass could not run", error);
	}
}
