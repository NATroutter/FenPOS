import "server-only";
import { rmSync } from "node:fs";
import { basename } from "node:path";
import { periodsFullyBefore } from "@/lib/archive/period";
import { listArchives } from "@/lib/archive/read";

/**
 * Deletes log archives whose period has fully aged out of `logs.archiveRetentionDays`.
 *
 * **Audit archives are never touched here, on purpose.** The audit epoch — the line a panel operator
 * draws saying "history before this point is gone" — is only allowed to move when a person takes the
 * explicit panel action that draws it (Task 13), because that action is also what advances the epoch
 * that vouches for everything after it. If this function swept `audit-*.db.gz` files too, the epoch
 * would advance every time an hourly timer happened to notice an old file, which is exactly what an
 * epoch exists not to do: an epoch that moves on a schedule is one an attacker can wait for rather
 * than defeat. So this filters to `source === "logs"` and leaves every `audit-*.db.gz` alone, however
 * old it is.
 *
 * A period is expired only once all of it is older than the window, the same rule
 * {@link periodsFullyBefore} states for the live databases: this calls it per archived period, with
 * that period's own first instant as `oldest`, rather than restating the month arithmetic here.
 *
 * Anything `listArchives` does not recognise — a `*.partial` left by an interrupted rotation, a bare
 * `.db` whose compression failed, a file this codebase never wrote — is invisible to this function
 * exactly as it is invisible to `listArchives`, and so is left alone.
 *
 * **"Left alone" means forever, and on the log side that is the whole cost.** A `logs-<period>.db`
 * whose gzip failed is a complete archive that the Archives tab cannot list, chain verification has no
 * reason to look for, and this function will never remove — so it is unreadable from the panel,
 * unpruned for the life of the install, and larger than the `.db.gz` it stands in for. Nothing here
 * repairs that, and nothing here reports it either: `lib/archive/rotate.ts`'s `compress` already writes
 * one `logger.error` naming the file at the moment it happens, and a second complaint on every hourly
 * pass would be an alarm nobody can silence about a file only an operator can deal with. Compressing or
 * moving it aside is that operator's job, and until they do it the file stays exactly where it is. The
 * audit side has the same blind spot and a harder edge on it: `deleteAuditArchive` refuses the whole
 * operation while an uncompressed audit archive is on disk, because there the cost is a false tamper
 * report rather than disk.
 *
 * @param directory where archives live; must already exist, and is read but never created here
 * @param retentionDays how many days a log archive is kept, i.e. `logs.archiveRetentionDays`
 * @returns the basenames of the files removed, oldest and newest alike, in no particular order
 */
export async function pruneLogArchives(directory: string, retentionDays: number): Promise<{ removed: string[] }> {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	const archives = await listArchives(directory);
	const removed: string[] = [];

	for (const archive of archives) {
		if (archive.source !== "logs") {
			continue;
		}

		const [year, month] = archive.periodKey.split("-").map(Number);
		const periodStart = new Date(Date.UTC(year, month - 1, 1));
		if (periodsFullyBefore(periodStart, cutoff).length === 0) {
			continue;
		}

		rmSync(archive.path, { force: true });
		removed.push(basename(archive.path));
	}

	return { removed };
}
