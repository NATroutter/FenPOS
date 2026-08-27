import "server-only";
import { periodsFullyBefore } from "@/lib/archive/period";
import { archivePeriod } from "@/lib/archive/rotate";
import { logsDb } from "@/lib/db";

/**
 * Removes log lines older than the retention window, archiving them first when asked to.
 *
 * By age rather than by row count, which is the whole point of the change: a cap evicts by volume,
 * so an afternoon of noise silently destroys the week an operator came to read. A window keeps what
 * happened when it happened, and the size that follows from it is affordable — a log row is a few
 * hundred bytes, so a month of a busy install is tens of megabytes.
 *
 * `VACUUM` follows the delete because SQLite does not return freed pages to the filesystem on its
 * own. Without it a burst permanently inflates the file even after retention has removed the rows.
 * It runs outside the delete's transaction because SQLite refuses to vacuum inside one.
 *
 * **The two paths differ because logs, unlike the audit record, have no filename to keep honest.**
 * With archiving off there is no archive to name, so there is nothing a period boundary would be
 * protecting — rounding the delete up to a whole calendar month would only retain more for no
 * benefit, so this deletes by the strict cutoff instead, exactly as it always has. With archiving
 * on, an archive file is named for a calendar month, so the same reasoning `sweepAuditNow` follows
 * applies here too: only a period that has *fully* aged out may be archived and removed, via
 * {@link periodsFullyBefore} and `archivePeriod`, oldest period first.
 *
 * @param retentionDays how long a line is kept
 * @param options whether aged-out lines are archived first, and where the archive goes
 * @returns how many lines were removed
 */
export async function sweepLogsNow(
	retentionDays: number,
	options: { archiveEnabled: boolean; archiveDirectory: string },
): Promise<{ removed: number }> {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

	if (!options.archiveEnabled) {
		const { count } = await logsDb.logEntry.deleteMany({ where: { ts: { lt: cutoff } } });

		if (count > 0) {
			await logsDb.$executeRawUnsafe("VACUUM");
		}

		return { removed: count };
	}

	const oldest = await logsDb.logEntry.findFirst({ orderBy: { ts: "asc" }, select: { ts: true } });
	if (!oldest) {
		return { removed: 0 };
	}

	const due = periodsFullyBefore(oldest.ts, cutoff);

	let removed = 0;
	for (const period of due) {
		// Oldest first, matching sweepAuditNow: each rotation archives a whole period before the next.
		const outcome = await archivePeriod({ source: "logs", before: period.before, directory: options.archiveDirectory });
		removed += outcome.rows;
	}

	if (removed > 0) {
		await logsDb.$executeRawUnsafe("VACUUM");
	}

	return { removed };
}
