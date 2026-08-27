import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archivePeriod } from "@/lib/archive/rotate";
import { appendEvent, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { verifyAuditChain } from "@/lib/audit/verify";
import { auditDb } from "@/lib/db";

/**
 * Following one chain across the boundary where half of it left the database.
 *
 * Once a period is archived the anchor proves the *live* rows are intact and says nothing at all about
 * the file the rest of them went into. These tests are about the other half: that the archived rows are
 * hash-checked too, and — the property that actually matters — that the archive's newest row is the one
 * the anchor names, so the two halves are one chain rather than two that each verify on their own.
 *
 * Nothing here backdates `at` with an `updateMany`. It is one of the sixteen fields the hash covers, so
 * a row edited into the past recomputes to a different digest and the archive it lands in reads as
 * tampered — which is the failure these tests exist to distinguish from a real one. The rows are aged by
 * appending them under a moved clock instead, exactly as `test/lib/archive/rotate.test.ts` does.
 */
describe("verifyAuditChain across an archive boundary", () => {
	let directory: string;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "fenpos-verify-archive-"));
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
	});

	afterEach(() => {
		vi.useRealTimers();
		// Every handle opened here and inside the walk is closed before returning, so this cannot fail on
		// a Windows lock — which is what it is here to catch if a `close()` is ever dropped.
		rmSync(directory, { recursive: true, force: true });
	});

	/**
	 * Records `count` events through the real writer, as of `at`.
	 *
	 * `appendEvent` rather than `recordAudit`, so building a fixture cannot itself trigger a sweep.
	 *
	 * @param count how many events to append
	 * @param at the moment they are recorded at
	 */
	async function chainAt(count: number, at: Date): Promise<void> {
		vi.useFakeTimers({ toFake: ["Date"], now: at });
		try {
			for (let index = 0; index < count; index++) {
				await appendEvent({ action: `verify:${index}`, outcome: "SUCCESS", actor: SYSTEM_ACTOR });
			}
		} finally {
			vi.useRealTimers();
		}
	}

	/**
	 * Edits a compressed archive in place, the way somebody with the file and a SQLite shell would.
	 *
	 * Decompress, open writable, run the statement, recompress over the original. The archive that comes
	 * back is a well-formed database that differs from the one rotation wrote — which is the only way to
	 * ask whether verification can tell.
	 *
	 * @param path the `.db.gz` rotation produced
	 * @param edit runs against the decompressed archive
	 */
	function editArchive(path: string, edit: (archive: Database.Database) => void): void {
		const plain = `${path}.edited.db`;
		writeFileSync(plain, gunzipSync(readFileSync(path)));

		const archive = new Database(plain);
		try {
			edit(archive);
		} finally {
			// Before the file is read back: Windows keeps it locked until the handle closes.
			archive.close();
		}

		writeFileSync(path, gzipSync(readFileSync(plain)));
		rmSync(plain, { force: true });
	}

	it("verifies the archive and its join to the live chain", async () => {
		await chainAt(3, new Date("2026-01-15T00:00:00Z"));
		await chainAt(3, new Date("2026-02-14T00:00:00Z"));
		await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory });

		expect(result.ok).toBe(true);
		// Six rows across two files, not three in one: goes red if the archive is skipped.
		expect(result.checked).toBe(6);
		expect(result).toMatchObject({ archived: 3, live: 3 });
	});

	it("reports tampering when an archived row is edited", async () => {
		await chainAt(3, new Date("2026-01-15T00:00:00Z"));
		await chainAt(1, new Date("2026-02-14T00:00:00Z"));
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		const outcome = await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		editArchive(outcome.path, (archive) => {
			archive.prepare("UPDATE audit_events SET detail = ? WHERE seq = ?").run("nothing happened", rows[1].seq);
		});

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory });

		// The whole point of archiving rather than deleting: the file is still evidence. `hash-mismatch`
		// at that exact row, not merely `ok: false` — an archive rebuilt badly would also be `ok: false`.
		expect(result).toMatchObject({ ok: false, brokenAt: rows[1].seq, reason: "hash-mismatch" });
	});

	it("detects an archived row removed from the end of the archive", async () => {
		await chainAt(3, new Date("2026-01-15T00:00:00Z"));
		await chainAt(3, new Date("2026-02-14T00:00:00Z"));
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		const outcome = await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		// The one edit that both halves accept on their own: the archive still verifies from genesis to
		// its new last row, and the live rows still verify against an anchor nobody touched. Only the join
		// between them notices that the row the anchor names is no longer in the file.
		editArchive(outcome.path, (archive) => {
			archive.prepare("DELETE FROM audit_events WHERE seq = ?").run(rows[2].seq);
		});

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory });

		expect(result).toMatchObject({ ok: false, brokenAt: rows[2].seq, reason: "archive-join-mismatch" });
		// Both values, because neither one alone tells the operator which side moved.
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toContain(rows[1].hash);
			expect(result.detail).toContain(rows[2].hash);
		}
	});

	it("carries the chain across two archived periods in period order", async () => {
		await chainAt(2, new Date("2025-12-15T00:00:00Z"));
		await chainAt(2, new Date("2026-01-15T00:00:00Z"));
		await chainAt(2, new Date("2026-02-14T00:00:00Z"));
		await archivePeriod({ source: "audit", before: new Date("2026-01-01T00:00:00Z"), directory });
		await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory });

		// December's archive does not start at genesis for January's rows: read in the wrong order, or
		// with the running hash reset between files, the second archive breaks its link.
		expect(result).toMatchObject({ ok: true, checked: 6, archived: 4, live: 2 });
	});

	it("verifies an archive whose compression failed and left the bare .db", async () => {
		await chainAt(3, new Date("2026-01-15T00:00:00Z"));
		await chainAt(3, new Date("2026-02-14T00:00:00Z"));
		const outcome = await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		// Exactly what `lib/archive/rotate.ts` leaves when `compress` throws: a complete, verified archive
		// under the period's real name, and no `.gz` beside it. The rows are in that file and nowhere else,
		// so a walk that only looks for `.db.gz` would find a gap the record does not have and report the
		// chain broken.
		const plain = join(directory, "audit-2026-01.db");
		writeFileSync(plain, gunzipSync(readFileSync(outcome.path)));
		rmSync(outcome.path, { force: true });

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory });

		expect(result).toMatchObject({ ok: true, checked: 6, archived: 3, live: 3 });
	});

	it("reports no archived rows when the archive directory does not exist", async () => {
		await chainAt(3, new Date("2026-02-14T00:00:00Z"));

		// Nothing schedules rotation, so an install that has never archived has no archive directory —
		// and `pnpm audit:verify` must report the chain it can see rather than crash on a missing folder.
		const result = await verifyAuditChain(auditDb, { archiveDirectory: join(directory, "never-created") });

		expect(result).toMatchObject({ ok: true, checked: 3, archived: 0, live: 3 });
	});
});
