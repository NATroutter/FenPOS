import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archivePeriod } from "@/lib/archive/rotate";
import { appendEvent, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { archiveChainReader, verifyAuditChain } from "@/lib/audit/verify";
import { auditDb, logsDb } from "@/lib/db";

/**
 * Moving a period out of the live window without ever risking it.
 *
 * The property under test is the ordering — write, verify, delete, compress — not that rows end up
 * somewhere. A rotation that deleted first and then failed would pass every "the archive holds the
 * rows" assertion on a good day and destroy a month of history on a bad one, so the tests that matter
 * most here are the two that make a step fail on purpose and then look at what is still live.
 */
describe("archivePeriod", () => {
	let directory: string;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "fenpos-archive-"));
		await logsDb.logEntry.deleteMany({});
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
		await auditDb.auditEpoch.deleteMany({});
	});

	afterEach(() => {
		vi.useRealTimers();
		// Every handle these tests and `archivePeriod` open is closed before returning, so this cannot
		// fail on a lock — which is what it is here to catch if a `close()` is ever dropped.
		rmSync(directory, { recursive: true, force: true });
	});

	/**
	 * Opens an archive that rotation has already compressed.
	 *
	 * Decompressed to a sibling file rather than read in place, because SQLite needs a seekable file.
	 * The caller closes the handle it gets back.
	 *
	 * @param path the `.db.gz` rotation produced
	 * @returns a read-only handle on its contents
	 */
	function openArchive(path: string): Database.Database {
		const plain = `${path}.opened.db`;
		writeFileSync(plain, gunzipSync(readFileSync(path)));
		return new Database(plain, { readonly: true, fileMustExist: true });
	}

	/**
	 * Records `count` events through the real writer, as of `at`.
	 *
	 * The clock is moved rather than the rows being backdated afterwards, because `at` is one of the
	 * sixteen fields the hash covers: a raw update to it leaves rows that read as tampered, which is
	 * indistinguishable from the failure some of these tests are trying to prove does *not* happen.
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
				await appendEvent({ action: `archive:${index}`, outcome: "SUCCESS", actor: SYSTEM_ACTOR });
			}
		} finally {
			vi.useRealTimers();
		}
	}

	it("does not delete live rows when writing the archive fails", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "must survive", ts: new Date("2026-01-15T00:00:00Z") },
		});

		await expect(
			archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory: "/does/not/exist" }),
		).rejects.toThrow(/directory does not exist/i);

		// The safety property: a failed archive loses nothing.
		expect(await logsDb.logEntry.findFirst({ where: { message: "must survive" } })).not.toBeNull();
	});

	it("archives, then removes from live, and the archive holds every row", async () => {
		await logsDb.logEntry.createMany({
			data: Array.from({ length: 5 }, (_, index) => ({
				level: "INFO" as const,
				severity: 1,
				message: `old ${index}`,
				ts: new Date("2026-01-15T00:00:00Z"),
			})),
		});

		const outcome = await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		expect(outcome.rows).toBe(5);
		expect(outcome.periodKey).toBe("2026-01");
		expect(await logsDb.logEntry.count({ where: { message: { startsWith: "old" } } })).toBe(0);
		expect(existsSync(outcome.path)).toBe(true);
		expect(outcome.path.endsWith(".db.gz")).toBe(true);

		const archive = openArchive(outcome.path);
		try {
			const { rows } = archive.prepare("SELECT COUNT(*) AS rows FROM log_entries").get() as { rows: number };
			expect(rows).toBe(5);
		} finally {
			archive.close();
		}
	});

	it("leaves lines newer than the boundary in the live database", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "old", ts: new Date("2026-01-15T00:00:00Z") },
		});
		await logsDb.logEntry.create({
			data: { level: "WARN", severity: 2, message: "current", ts: new Date("2026-02-14T00:00:00Z") },
		});

		const outcome = await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		expect(outcome.rows).toBe(1);
		const live = await logsDb.logEntry.findMany();
		expect(live).toHaveLength(1);
		expect(live[0].message).toBe("current");
	});

	it("leaves a line written at the boundary instant in the live database", async () => {
		const boundary = new Date("2026-02-01T00:00:00.000Z");
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "last of january", ts: new Date("2026-01-31T23:59:59.999Z") },
		});
		await logsDb.logEntry.create({ data: { level: "INFO", severity: 1, message: "first of february", ts: boundary } });

		const outcome = await archivePeriod({ source: "logs", before: boundary, directory });

		// The boundary is exclusive, and this is the assertion that says so: the line at exactly the
		// boundary belongs to February. Goes red on an inclusive `lte`, which would archive it into a file
		// named `logs-2026-01` and delete it from live.
		expect(outcome.rows).toBe(1);
		const live = await logsDb.logEntry.findMany();
		expect(live).toHaveLength(1);
		expect(live[0].message).toBe("first of february");
	});

	it("round-trips every log column, timestamps included", async () => {
		await logsDb.logEntry.create({
			data: {
				id: "archived-line",
				level: "ERROR",
				severity: 3,
				message: "printer on fire",
				ts: new Date("2026-01-15T09:30:15.250Z"),
				agentId: "agent-1",
				deviceId: "device-1",
				agentName: "Till agent",
				deviceName: "Kitchen printer",
			},
		});

		const outcome = await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		const archive = openArchive(outcome.path);
		try {
			const row = archive.prepare("SELECT * FROM log_entries WHERE id = ?").get("archived-line") as Record<
				string,
				unknown
			>;
			expect(row.level).toBe("ERROR");
			expect(row.severity).toBe(3);
			expect(row.message).toBe("printer on fire");
			expect(row.agent_id).toBe("agent-1");
			expect(row.device_id).toBe("device-1");
			expect(row.agent_name).toBe("Till agent");
			expect(row.device_name).toBe("Kitchen printer");
			// The timestamp must survive as a moment, not as whatever the host's zone made of it.
			expect(new Date(row.ts as string).toISOString()).toBe("2026-01-15T09:30:15.250Z");
		} finally {
			archive.close();
		}
	});

	it("gives the archive the same columns the live table has", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "old", ts: new Date("2026-01-15T00:00:00Z") },
		});

		const outcome = await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		// Goes red the moment a migration adds a column to `log_entries` and the archive's copy of the
		// DDL is not updated with it — which would otherwise silently drop that column's history.
		const live = await logsDb.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM pragma_table_info('log_entries')");
		const archive = openArchive(outcome.path);
		try {
			const archived = archive.prepare("SELECT name FROM pragma_table_info('log_entries')").all() as { name: string }[];
			expect(archived.map((column) => column.name)).toEqual(live.map((column) => column.name));
		} finally {
			archive.close();
		}
	});

	it("refuses to write over an archive that already exists", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "first", ts: new Date("2026-01-15T00:00:00Z") },
		});
		await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "second", ts: new Date("2026-01-16T00:00:00Z") },
		});

		await expect(
			archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory }),
		).rejects.toThrow(/already exists/i);
		// The second line is still live rather than gone into a file that overwrote the first.
		expect(await logsDb.logEntry.count({ where: { message: "second" } })).toBe(1);
	});

	it("refuses when only the uncompressed archive is on disk, and names the remedy", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "still live", ts: new Date("2026-01-15T00:00:00Z") },
		});
		// The other branch of the guard: what a rotation whose compression failed leaves behind is a
		// bare `.db` with no `.gz` beside it. The test above only reaches the `.gz` branch.
		writeFileSync(join(directory, "logs-2026-01.db"), "");

		// This is the one refusal a retry cannot clear on its own, so it has to say what to do about it.
		await expect(
			archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory }),
		).rejects.toThrow(/Move or remove that file/);

		expect(await logsDb.logEntry.count()).toBe(1);
	});

	it("lets the period be rotated again after a rotation dies before the delete", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "old", ts: new Date("2026-01-15T00:00:00Z") },
		});
		const before = new Date("2026-02-01T00:00:00Z");

		// Exactly what a Prisma transaction timeout does: the archive is written and verified, and then
		// the delete does not happen. Injected rather than provoked, because provoking it for real needs a
		// month of a busy install's log volume.
		let namesMidRotation: string[] = [];
		const failing = vi.spyOn(logsDb, "$transaction").mockImplementationOnce((async () => {
			// Read at the exact moment a hard kill would be unrecoverable: the archive is written and
			// verified, and the rows are still live. Nothing may carry the period's real name yet.
			namesMidRotation = readdirSync(directory);
			throw new Error("Transaction API error: Transaction already closed");
		}) as typeof logsDb.$transaction);

		await expect(archivePeriod({ source: "logs", before, directory })).rejects.toThrow(/Transaction/);
		failing.mockRestore();

		// Goes red on an archive written straight to its real name — which is what a crash between the
		// write and the delete would then leave behind, refusing every retry from that point on.
		expect(namesMidRotation).toHaveLength(1);
		expect(namesMidRotation[0]).toMatch(/^logs-2026-01\.db\..+\.partial$/);

		// Nothing was lost, and this rotation cleaned up after itself rather than leaving its own attempt.
		expect(await logsDb.logEntry.count()).toBe(1);
		expect(readdirSync(directory)).toEqual([]);

		const outcome = await archivePeriod({ source: "logs", before, directory });

		expect(outcome.rows).toBe(1);
		expect(await logsDb.logEntry.count()).toBe(0);
		expect(existsSync(outcome.path)).toBe(true);
	});

	it("is not blocked by an attempt a crash left behind, and does not remove it", async () => {
		await logsDb.logEntry.create({
			data: { level: "INFO", severity: 1, message: "old", ts: new Date("2026-01-15T00:00:00Z") },
		});
		// What a hard kill mid-rotation leaves: an attempt file under a name no finished archive can
		// have. No `catch` ran, so nothing cleaned it up — the case the provisional name exists for and
		// the one an in-process cleanup cannot reach.
		const wreckage = "logs-2026-01.db.11111111-2222-3333-4444-555555555555.partial";
		writeFileSync(join(directory, wreckage), "not a database");

		const outcome = await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		expect(outcome.rows).toBe(1);
		expect(existsSync(outcome.path)).toBe(true);
		// And it is left alone rather than tidied away: only the rotation that wrote an attempt file may
		// remove it, because after a failed promotion one of these is the only copy of its rows.
		expect(readdirSync(directory)).toContain(wreckage);
	});

	it("gives the audit archive the same columns the live table has", async () => {
		await chainAt(1, new Date("2026-01-15T00:00:00Z"));

		const outcome = await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		const live = await auditDb.$queryRawUnsafe<{ name: string }[]>(
			"SELECT name FROM pragma_table_info('audit_events')",
		);
		const archive = openArchive(outcome.path);
		try {
			const archived = archive.prepare("SELECT name FROM pragma_table_info('audit_events')").all() as {
				name: string;
			}[];
			expect(archived.map((column) => column.name)).toEqual(live.map((column) => column.name));
		} finally {
			archive.close();
		}
	});

	it("archives a prefix of the audit chain and re-anchors what stays live", async () => {
		await chainAt(4, new Date("2026-01-15T00:00:00Z"));
		await chainAt(2, new Date("2026-02-14T00:00:00Z"));
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });

		const outcome = await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		expect(outcome.rows).toBe(4);
		expect(outcome.periodKey).toBe("2026-01");
		expect(await auditDb.auditEvent.count()).toBe(2);
		// The anchor names the newest event that left, which is what lets the two survivors verify.
		const anchor = await auditDb.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });
		expect(anchor.seq).toBe(rows[3].seq);
		expect(anchor.hash).toBe(rows[3].hash);
		expect((await verifyAuditChain(auditDb)).ok).toBe(true);
	});

	it("leaves the archived audit rows verifiable as a chain in their own file", async () => {
		await chainAt(5, new Date("2026-01-15T00:00:00Z"));

		const outcome = await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		const archive = openArchive(outcome.path);
		try {
			// Genesis, because nothing had been swept before this rotation: the archive is the front of
			// the chain. An `at` that came back from SQLite as a string rather than a Date would recompute
			// to a different digest here and report `hash-mismatch`.
			const result = await verifyAuditChain(archiveChainReader(archive, null));
			expect(result).toMatchObject({ ok: true, checked: 5 });
		} finally {
			archive.close();
		}
	});

	it("verifies an archive against the anchor the previous rotation left behind", async () => {
		await chainAt(3, new Date("2025-12-15T00:00:00Z"));
		await chainAt(3, new Date("2026-01-15T00:00:00Z"));
		await archivePeriod({ source: "audit", before: new Date("2026-01-01T00:00:00Z"), directory });

		// The second period's archive does not start at genesis: its oldest row links to the last row of
		// the first period, and only the anchor written by the first rotation can vouch for that.
		const anchor = await auditDb.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });
		const outcome = await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		const archive = openArchive(outcome.path);
		try {
			expect(await verifyAuditChain(archiveChainReader(archive, anchor))).toMatchObject({ ok: true, checked: 3 });
			// And genesis is the wrong anchor for it, which is what makes the assertion above mean something.
			expect(await verifyAuditChain(archiveChainReader(archive, null))).toMatchObject({ ok: false });
		} finally {
			archive.close();
		}
	});

	it("does not delete live audit rows when the archived chain does not verify", async () => {
		await chainAt(4, new Date("2026-01-15T00:00:00Z"));
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		// A raw edit to a covered column: this row's stored hash no longer matches its own contents, so
		// the copy of it in the archive fails verification at step 4. Nothing here touches the archive —
		// the chain is broken in live and copied faithfully, which is exactly what verification is for.
		await auditDb.auditEvent.update({ where: { seq: rows[1].seq }, data: { action: "archive:innocent" } });

		await expect(
			archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory }),
		).rejects.toThrow(/hash-mismatch/);

		// Verification gates the delete: every row is still where it was, and nothing was anchored.
		expect(await auditDb.auditEvent.count()).toBe(4);
		expect(await auditDb.auditAnchor.findUnique({ where: { id: 1 } })).toBeNull();
	});

	it("leaves an audit event written at the boundary instant out of the archive", async () => {
		const boundary = new Date("2026-02-01T00:00:00.000Z");
		await chainAt(1, new Date("2026-01-15T00:00:00Z"));
		await chainAt(1, boundary);
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });

		const outcome = await archivePeriod({ source: "audit", before: boundary, directory });

		// All three assertions go red on an inclusive `lte`, which would put a February event into
		// January's file, delete it from live, and — worst of the three — anchor on it, so Task 8's walk
		// across the boundary would look for it in the wrong segment of the chain.
		expect(outcome.rows).toBe(1);
		const live = await auditDb.auditEvent.findMany();
		expect(live.map((row) => row.seq)).toEqual([rows[1].seq]);
		const anchor = await auditDb.auditAnchor.findUniqueOrThrow({ where: { id: 1 } });
		expect(anchor.seq).toBe(rows[0].seq);

		const archive = openArchive(outcome.path);
		try {
			expect(archive.prepare("SELECT seq FROM audit_events WHERE seq = ?").get(rows[1].seq)).toBeUndefined();
		} finally {
			archive.close();
		}
	});

	it("leaves audit events newer than the boundary alone", async () => {
		await chainAt(1, new Date("2026-01-15T00:00:00Z"));
		await chainAt(2, new Date("2026-02-14T00:00:00Z"));

		const outcome = await archivePeriod({ source: "audit", before: new Date("2026-02-01T00:00:00Z"), directory });

		expect(outcome.rows).toBe(1);
		expect(await auditDb.auditEvent.count()).toBe(2);
	});

	it("writes an archive for a period that has nothing in it", async () => {
		const outcome = await archivePeriod({ source: "logs", before: new Date("2026-02-01T00:00:00Z"), directory });

		expect(outcome.rows).toBe(0);
		expect(existsSync(outcome.path)).toBe(true);
	});
});
