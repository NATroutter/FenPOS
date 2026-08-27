import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listArchives, readArchive } from "@/lib/archive/read";
import { archivePeriod } from "@/lib/archive/rotate";
import { logsDb } from "@/lib/db";

/**
 * Reading a compressed archive back without treating the directory it lives in as trustworthy.
 *
 * Rotation leaves more than finished archives behind — provisional names, abandoned attempts, and
 * whatever else lands in the directory — so the tests here cover two different failure shapes: a
 * reader that gets confused about *which files are archives*, and a reader that leaks its own
 * temporary file, whether the caller's query succeeds, throws, or runs concurrently with another.
 */
describe("listArchives", () => {
	let directory: string;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "fenpos-archive-list-"));
		await logsDb.logEntry.deleteMany({});
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("lists finished archives with their period, source and size", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "old", ts: new Date("2026-01-15T00:00:00Z") },
		});
		const outcome = await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		const found = await listArchives(directory);

		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ periodKey: "2026-01", source: "logs", path: outcome.path });
		expect(found[0].bytes).toBeGreaterThan(0);
	});

	it("ignores an abandoned partial attempt and an unrelated file, rather than listing or throwing on them", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "kept", ts: new Date("2026-01-15T00:00:00Z") },
		});
		const outcome = await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		// What Task 6 leaves behind that is not an archive: an abandoned attempt under its provisional
		// name, an uncompressed file whose compression never finished, and a file nothing here wrote at
		// all. Goes red if `listArchives` globs `logs-*` instead of the exact `.db.gz` suffix.
		writeFileSync(
			join(directory, "logs-2026-03.db.11111111-2222-3333-4444-555555555555.partial"),
			"not a finished archive",
		);
		writeFileSync(join(directory, "logs-2026-04.db"), "compression never ran");
		writeFileSync(join(directory, "notes.txt"), "not an archive at all");

		const found = await listArchives(directory);

		expect(found).toHaveLength(1);
		expect(found[0].path).toBe(outcome.path);
	});
});

describe("readArchive", () => {
	let directory: string;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "fenpos-archive-read-"));
		await logsDb.logEntry.deleteMany({});
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("finds rows in a compressed archive without disturbing it", async () => {
		// Built through archivePeriod rather than by hand, so a change to the archive's shape that
		// broke read-back would fail here rather than passing against a fixture nothing writes.
		await logsDb.logEntry.create({
			data: { level: "WARN", severity: 2, message: "archived line", ts: new Date("2026-01-15T00:00:00Z") },
		});
		const archived = await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		const found = await readArchive(
			{ periodKey: "2026-01", source: "logs", path: archived.path, bytes: 0 },
			(db) => db.prepare("SELECT message FROM log_entries").all() as Array<{ message: string }>,
		);

		expect(found.map((row) => row.message)).toContain("archived line");
		// The archive is left compressed and intact for the next reader.
		expect(existsSync(archived.path)).toBe(true);
		expect(existsSync(archived.path.replace(/\.gz$/, ""))).toBe(false);
	});

	it("removes the temporary file when the callback throws", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "irrelevant", ts: new Date("1999-06-15T00:00:00Z") },
		});
		const archived = await archivePeriod({ source: "logs", before: new Date("1999-07-01T00:00:00Z"), directory });

		// A period unlikely to be used by any other test in this suite, so a leftover temporary file
		// this call itself produced cannot be mistaken for one another test happened to leave behind.
		const prefix = "logs-1999-06-";
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));

		await expect(
			readArchive({ periodKey: "1999-06", source: "logs", path: archived.path, bytes: 0 }, () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// Goes red if the temporary file is only removed on the success path — the exact mistake a
		// `try { ...; rmSync(...) }` without a `finally` makes.
		const after = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
		expect(after).toEqual(before);
	});

	it("does not collide when two callers read the same archive at once", async () => {
		await logsDb.logEntry.createMany({
			data: Array.from({ length: 3 }, (_, index) => ({
				level: "INFO" as const,
				severity: 1,
				message: `line ${index}`,
				ts: new Date("2020-03-15T00:00:00Z"),
			})),
		});
		const archived = await archivePeriod({ source: "logs", before: new Date("2020-04-01T00:00:00Z"), directory });
		const descriptor = { periodKey: "2020-03", source: "logs" as const, path: archived.path, bytes: 0 };
		const prefix = "logs-2020-03-";

		// Both readers decompress the same source file at once. A temporary name shared between them —
		// rather than one drawn from `randomUUID()` per call — would go red here: on Windows the second
		// reader would fail to open a file the first still has locked, or on any platform one reader's
		// query could see a partially written or already-removed copy of the other's decompression.
		const [first, second] = await Promise.all([
			readArchive(descriptor, async (db) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return (db.prepare("SELECT COUNT(*) AS rows FROM log_entries").get() as { rows: number }).rows;
			}),
			readArchive(descriptor, async (db) => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				return (db.prepare("SELECT COUNT(*) AS rows FROM log_entries").get() as { rows: number }).rows;
			}),
		]);

		expect(first).toBe(3);
		expect(second).toBe(3);
		// Both readers cleaned up after themselves; neither left the other's temporary file behind.
		expect(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix))).toEqual([]);
	});
});
