import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	 * `appendEvent` rather than `recordAudit`, so building a fixture cannot itself trigger a sweep.
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
