import "server-only";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import Database from "better-sqlite3";
import type { ArchiveSource } from "@/lib/archive/rotate";

/**
 * Making a rotated period findable and readable, without ever opening it where it lives.
 *
 * `lib/archive/rotate.ts` writes archives; this reads them back. It exists because a file rotation
 * cannot be queried is storage rather than a record — Task 8's chain walk and the panel's archive
 * browser both start from `listArchives`, and both open a period through `readArchive` rather than
 * reaching into `.db.gz` directly.
 *
 * **The archive itself is never opened in place.** gzip is not seekable, so a SQLite handle cannot
 * sit on top of one — and even if it could, decompressing beside the live database would put a
 * second copy of the record where retention does not manage it: nothing in this plan prunes archives
 * by age, so a stray decompressed copy next to `logs.db` or `audit.db` would simply accumulate.
 * `readArchive` decompresses into `os.tmpdir()` instead, a location that belongs to neither database's
 * retention nor the archive directory's contents, and removes what it wrote there before returning.
 *
 * **Nothing here walks a chain or orders periods.** `listArchives` returns what is on disk; Task 8's
 * job is deciding what order to read it in and what to do with what it finds.
 */

/** What one archive on disk is, as far as a reader needs to know before opening it. */
export interface ArchiveDescriptor {
	/** The period the archive covers, e.g. `2026-01`. */
	periodKey: string;
	/** Which live database this period was drained from. */
	source: ArchiveSource;
	/** The compressed file's path, exactly as `archivePeriod` left it. */
	path: string;
	/** The compressed file's size in bytes, read from the filesystem at list time. */
	bytes: number;
}

/**
 * Names a finished, compressed archive: `<source>-<periodKey>.db.gz`.
 *
 * Only this exact shape. Rotation can leave an abandoned `*.partial` file or a `.db` whose
 * compression failed sitting in the same directory — matching a loose prefix like `logs-*` would
 * pick those up too, and an abandoned attempt read as a finished archive can hold a partial or empty
 * copy of the period, which is worse than not listing it at all.
 */
const ARCHIVE_NAME = /^(logs|audit)-(\d{4}-\d{2})\.db\.gz$/;

/**
 * Lists the finished archives in a directory.
 *
 * Deliberately only `.db.gz`: a `.db` left behind when compression failed is a real, verified
 * archive (see `lib/archive/rotate.ts`'s `compress`), but reading it needs a different path than a
 * compressed one and nothing here has a test pinning that path. Listing it today, untested, would be
 * exactly the kind of accidental answer this codebase has been burned by before — a later task that
 * wants that case can add it deliberately, with a fixture that exercises it.
 *
 * Anything else in the directory — a `*.partial` attempt, a bare `.db`, a file nothing here wrote —
 * is skipped rather than treated as an error. A stray file in an archive directory is not a reason to
 * refuse to list the archives that are actually there.
 *
 * @param directory where `archivePeriod` has been writing archives
 * @returns one descriptor per finished archive found, in no particular order
 */
export async function listArchives(directory: string): Promise<ArchiveDescriptor[]> {
	const descriptors: ArchiveDescriptor[] = [];

	for (const name of readdirSync(directory)) {
		const match = ARCHIVE_NAME.exec(name);
		if (match === null) {
			continue;
		}

		const [, source, periodKey] = match;
		const path = join(directory, name);
		descriptors.push({ periodKey, source: source as ArchiveSource, path, bytes: statSync(path).size });
	}

	return descriptors;
}

/**
 * Reads a compressed archive without disturbing it.
 *
 * Decompresses to a fresh file under `os.tmpdir()`, opens that copy read-only with `better-sqlite3`,
 * runs `query` against it, and removes the temporary file whether `query` returns or throws — a
 * reader that failed halfway and left its scratch file behind would slowly fill the temp directory
 * with copies of archived periods.
 *
 * The temporary file's name includes a fresh `randomUUID()` — the same device `rotate.ts` uses for
 * its own provisional names — so two callers reading the same archive at once decompress into two
 * different files rather than racing to write, read, or delete one shared one.
 *
 * Opened readonly: a handle that could write to a decompressed archive would contradict the point of
 * having one. The temporary copy is disposable, but `query` should never be able to tell that from
 * what it is allowed to do with it.
 *
 * @param descriptor the archive to read, as `listArchives` returns it; only `path` is read here
 * @param query runs against the decompressed archive; its return value is this function's return value
 * @returns whatever `query` returned
 * @throws whatever `query` threw, or an error from decompressing or opening the archive
 */
export async function readArchive<T>(
	descriptor: ArchiveDescriptor,
	query: (archive: Database.Database) => T | Promise<T>,
): Promise<T> {
	const plain = join(tmpdir(), `${descriptor.source}-${descriptor.periodKey}-${randomUUID()}.db`);

	try {
		await pipeline(createReadStream(descriptor.path), createGunzip(), createWriteStream(plain));

		const archive = new Database(plain, { readonly: true, fileMustExist: true });
		try {
			return await query(archive);
		} finally {
			// Before the outer `finally` tries to remove the file: Windows will not remove one with an
			// open handle, and a leaked handle would keep the temporary file locked for the rest of the
			// process, the same discipline `rotate.ts`'s `intoArchive` follows for its own handles.
			archive.close();
		}
	} finally {
		rmSync(plain, { force: true });
	}
}
