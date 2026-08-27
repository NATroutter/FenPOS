import "server-only";
import { logsDb } from "@/lib/db";

/**
 * Removes log lines older than the retention window.
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
 * @param retentionDays how long a line is kept
 * @returns how many lines were removed
 */
export async function sweepLogsNow(retentionDays: number): Promise<{ removed: number }> {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	const { count } = await logsDb.logEntry.deleteMany({ where: { ts: { lt: cutoff } } });

	if (count > 0) {
		await logsDb.$executeRawUnsafe("VACUUM");
	}

	return { removed: count };
}
