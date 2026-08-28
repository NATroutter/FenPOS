import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archivePeriod } from "@/lib/archive/rotate";
import { appendEvent, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { GENESIS_HASH } from "@/lib/audit/chain";
import { readEpoch } from "@/lib/audit/epoch";
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
		await auditDb.auditEpoch.deleteMany({});
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
	 * `appendEvent` rather than `recordAudit` because that is the name a writer outside a request
	 * says; the two do the same thing now that retention has left the write path.
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

	/**
	 * Six events, three in January and three in February, as the chain actually stored them.
	 *
	 * Aged by appending under a moved clock rather than by editing `at` afterwards, for the reason this
	 * file's own comment gives: `at` is hashed, so a backdated row reads as tampered — which is the one
	 * finding the tests below exist to tell a legitimate sweep apart from.
	 *
	 * @returns the six rows in `seq` order, read back before anything is archived or removed
	 */
	async function chainOfSix() {
		await chainAt(3, new Date("2026-01-15T00:00:00Z"));
		await chainAt(3, new Date("2026-02-14T00:00:00Z"));
		return await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
	}

	it("reports history swept before archiving as incomplete, not as tampering", async () => {
		const rows = await chainOfSix();

		// The storage foundation's retention, reproduced exactly: a raw delete of the oldest rows and an
		// anchor on the newest one removed, with no archive written and no epoch claimed — because
		// neither existed then. This is the state of every install upgraded from that arrangement.
		await auditDb.auditEvent.deleteMany({ where: { seq: { lte: rows[2].seq } } });
		await auditDb.auditAnchor.create({ data: { id: 1, seq: rows[2].seq, hash: rows[2].hash } });

		// Archiving arrives. The first sweep under it claims the epoch on the oldest row it covers, which
		// is where the record stops being an accusation and starts being a boundary.
		await archivePeriod({ source: "audit", before: new Date("2026-03-01T00:00:00Z"), directory });

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory, epoch: await readEpoch() });

		// Goes red if the walk still starts the oldest archive at genesis: that archive's oldest row names
		// a predecessor the old sweep took away, so the walk reports `link-mismatch` and
		// `describeVerification` renders it as an accusation of tampering against nobody.
		expect(result.ok).toBe("incomplete");
		expect(result).toMatchObject({ verifiedFrom: rows[3].seq, checked: 3, archived: 3, live: 0 });
	});

	it("does not call a chain incomplete when the archives were never walked", async () => {
		const rows = await chainOfSix();
		await chainAt(2, new Date("2026-03-14T00:00:00Z"));
		await auditDb.auditEvent.deleteMany({ where: { seq: { lte: rows[2].seq } } });
		await auditDb.auditAnchor.create({ data: { id: 1, seq: rows[2].seq, hash: rows[2].hash } });
		await archivePeriod({ source: "audit", before: new Date("2026-03-01T00:00:00Z"), directory });

		// The same install as the case above, asked with an epoch but no archive directory, so nothing in
		// front of the anchor is opened at all. No caller passes an epoch without a directory — the panel
		// and the CLI pass both, `lib/archive/rotate.ts` passes neither — and this is what holds the
		// answer honest for one that does.
		const result = await verifyAuditChain(auditDb, { epoch: await readEpoch() });

		// Goes red if `"incomplete"` is returned on the strength of the epoch alone. That answer reads
		// "The audit chain is intact from seq 4", naming rows this walk never opened — the same false
		// reassurance the third outcome exists to remove, pointed the other way round.
		expect(result.ok).toBe(true);
		expect(result).toMatchObject({ checked: 2, archived: 0, live: 2 });
	});

	it("reports a freshly archived install as whole rather than as incomplete", async () => {
		const rows = await chainOfSix();
		await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		// Nothing was ever swept without being archived here, so the epoch is the chain's own first row
		// and nothing is missing in front of it. Asserted rather than assumed: it is the premise the case
		// below rests on, and `chainOfSix` is what would silently change it.
		expect(await readEpoch()).toEqual({ seq: rows[0].seq, prevHash: GENESIS_HASH });

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory, epoch: await readEpoch() });

		// Goes red if the walk reports `"incomplete"` whenever an epoch exists, rather than only when the
		// epoch starts later than the chain does: every install that has ever archived would then describe
		// itself as unverifiable, which is a worse false alarm than the one this task removed.
		expect(result.ok).toBe(true);
		expect(result).toMatchObject({ checked: 6, archived: 3, live: 3 });
	});

	it("reports a missing archive as a break", async () => {
		const rows = await chainOfSix();
		await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		// The epoch says archived history begins at the chain's first row; the file that held it is gone.
		rmSync(join(directory, "audit-2026-01.db.gz"));

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory, epoch: await readEpoch() });

		// Goes red on the pre-epoch behaviour, which reported `ok: true` with `0 from archives` — nothing
		// recorded how far back the archives should reach, so deleting all of them was undetectable.
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ reason: "archive-missing" });
		expect(result.ok === false && result.detail).toContain(`seq ${rows[0].seq}`);
	});

	it("reports a break when the oldest archive starts later than the epoch says", async () => {
		await chainAt(2, new Date("2025-12-15T00:00:00Z"));
		await chainAt(2, new Date("2026-01-15T00:00:00Z"));
		await chainAt(2, new Date("2026-02-14T00:00:00Z"));
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		await archivePeriod({ source: "audit", before: new Date("2026-01-01T00:00:00Z"), directory });
		await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		// One archive of two removed, so the archives still walk as a chain among themselves — January's
		// file is intact and joins the live rows through the anchor. Only the epoch knows December was
		// ever there.
		rmSync(join(directory, "audit-2025-12.db.gz"));

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory, epoch: await readEpoch() });

		// `archive-missing`, not `anchor-mismatch`: without the check against the epoch the walk starts
		// January's file from December's last hash and blames January's oldest row, which is intact and
		// is not the thing that went.
		expect(result).toMatchObject({ ok: false, reason: "archive-missing", brokenAt: rows[0].seq });
		expect(result.ok === false && result.detail).toContain(`seq ${rows[2].seq}`);
	});

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
		// Both values, because neither one alone tells the operator which side moved. `=== false` rather
		// than `!result.ok`, here and below: `ok` has an `"incomplete"` member too, and it is truthy.
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.detail).toContain(rows[1].hash);
			expect(result.detail).toContain(rows[2].hash);
		}
	});

	it("reports a break when the anchor the archives join to has been deleted", async () => {
		await chainAt(3, new Date("2026-01-15T00:00:00Z"));
		await chainAt(3, new Date("2026-02-14T00:00:00Z"));
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		// The cheapest move available to somebody who wants the two halves uncoupled: with no anchor, the
		// live rows have nothing to be checked against and the archive has nothing to be joined to. Goes
		// red if the null branch of the join is dropped — the walk would then carry the archive's last hash
		// straight into the live segment, the oldest live row would link to it, and six events would
		// verify against a database that no longer records that any of them were archived.
		await auditDb.auditAnchor.deleteMany({});

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory });

		expect(result).toMatchObject({ ok: false, brokenAt: rows[2].seq, reason: "archive-join-mismatch" });
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.detail).toContain("no anchor");
		}
	});

	it("verifies an archive that holds the whole record, with nothing left live", async () => {
		await chainAt(3, new Date("2026-01-15T00:00:00Z"));

		await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		// An empty live table is a real answer here rather than an empty record: every event is in the
		// file, and the anchor is all the database still has of them. The control for the case below.
		expect(await auditDb.auditEvent.count()).toBe(0);
		expect(await verifyAuditChain(auditDb, { archiveDirectory: directory })).toMatchObject({
			ok: true,
			checked: 3,
			archived: 3,
			live: 0,
		});
	});

	it("detects a truncated archive when there are no live rows to catch it instead", async () => {
		await chainAt(3, new Date("2026-01-15T00:00:00Z"));
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		const outcome = await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		editArchive(outcome.path, (archive) => {
			archive.prepare("DELETE FROM audit_events WHERE seq = ?").run(rows[2].seq);
		});

		const result = await verifyAuditChain(auditDb, { archiveDirectory: directory });

		// Where the join is the only thing standing: with the live table empty there is no oldest live row
		// whose `prevHash` could notice, so removing the join assertion does not merely mislabel this — it
		// returns `ok: true` over an archive that has lost an event. The test above is what says the empty
		// live table is not itself the reason this fails.
		expect(result).toMatchObject({ ok: false, brokenAt: rows[2].seq, reason: "archive-join-mismatch" });
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
