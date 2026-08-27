import type { Database } from "better-sqlite3";
import type { PrismaClient } from "@/generated/prisma-audit/client";
import type { ChainedFields } from "@/lib/audit/chain";
import { GENESIS_HASH, hashEvent } from "@/lib/audit/chain";

/**
 * Walking the chain and reporting where it breaks.
 *
 * Read-only, and deliberately so: there is no repair. A chain that fails verification is evidence,
 * and a function that could "fix" it would be a function that could erase the evidence — which is
 * the exact capability the hash chain exists to deny.
 *
 * **The client is passed in rather than imported.** `lib/db.ts` begins with `import "server-only"`,
 * which throws in a plain node process — and `pnpm audit:verify` is a plain node process, run from
 * a shell precisely because the panel is what an attacker holding superuser credentials already
 * has. Taking the client as an argument is what keeps this module reachable from both sides;
 * `scripts/seed-demo-data.ts` builds its own client for the same reason.
 *
 * **What this detects:** an edited row (its own hash no longer matches its contents), a removed row
 * (its successor's link no longer matches the row now preceding it), a forged insert, and a swept
 * range whose anchor does not match what survived it.
 *
 * **What this cannot detect: truncation at the tail.** Deleting the newest rows leaves a shorter
 * chain that verifies perfectly, because nothing inside the table records how long it should be.
 * That is inherent to a self-contained chain rather than a gap in this implementation, and the
 * remedy is state kept where the attacker is not — shipping rows off the box, or recording the tail
 * somewhere else. Neither is in scope here, and pretending otherwise would be worse than saying so.
 */

/** How the chain failed. */
export type ChainBreak =
	/** The row's stored hash does not match a hash recomputed from its own columns. */
	| "hash-mismatch"
	/** The row's `prevHash` does not match the hash of the row before it. */
	| "link-mismatch"
	/** The oldest retained row's `prevHash` does not match what `AuditAnchor` says was swept. */
	| "anchor-mismatch";

/** The outcome of a walk. */
export type ChainVerification =
	| { ok: true; checked: number; firstSeq: number | null; lastSeq: number | null }
	| { ok: false; checked: number; brokenAt: number; reason: ChainBreak };

/**
 * Rows read per query.
 *
 * The walk is streamed rather than loaded whole: an install that has been running for a year has
 * more audit rows than anything else in the database, and `pnpm audit:verify` must not be the
 * command that runs it out of memory.
 */
const BATCH_SIZE = 500;

/**
 * The reads a walk needs.
 *
 * A structural subset of the audit database's `PrismaClient` rather than the client itself, so the
 * signature says what this does: it reads two tables and writes nothing. Handing a verifier
 * something that could `update` or `delete` an audit row would contradict the whole shape of the
 * record.
 *
 * The audit client, not the application's: `AuditEvent` and `AuditAnchor` live in `audit.db`, so
 * the application's generated client has neither property and passing it here is a type error.
 */
export type AuditChainReader = Pick<PrismaClient, "auditAnchor" | "auditEvent">;

/**
 * Verifies the retained chain.
 *
 * @param db a client for the database to read; the panel passes the shared one, the CLI its own
 * @returns confirmation with the range checked, or the exact `seq` at which it breaks and how
 */
export async function verifyAuditChain(db: AuditChainReader): Promise<ChainVerification> {
	// Absent on an install that has never swept, which is not a fault: it means the chain still
	// starts where it started, at genesis.
	const anchor = await db.auditAnchor.findUnique({ where: { id: 1 } });

	let expectedPrevHash = anchor?.hash ?? GENESIS_HASH;
	let cursor = anchor?.seq ?? 0;
	let checked = 0;
	let firstSeq: number | null = null;
	let lastSeq: number | null = null;

	for (;;) {
		const rows = await db.auditEvent.findMany({
			where: { seq: { gt: cursor } },
			orderBy: { seq: "asc" },
			take: BATCH_SIZE,
		});

		if (rows.length === 0) {
			return { ok: true, checked, firstSeq, lastSeq };
		}

		for (const row of rows) {
			if (row.prevHash !== expectedPrevHash) {
				// Told apart so the report can say what happened rather than only where: an anchor
				// that disagrees with the oldest surviving row is a retention fault or a doctored
				// anchor, while a mismatch further in is a row that is no longer there.
				const reason: ChainBreak = checked === 0 && anchor !== null ? "anchor-mismatch" : "link-mismatch";
				return { ok: false, checked, brokenAt: row.seq, reason };
			}

			if (hashEvent(row, row.prevHash) !== row.hash) {
				return { ok: false, checked, brokenAt: row.seq, reason: "hash-mismatch" };
			}

			expectedPrevHash = row.hash;
			firstSeq ??= row.seq;
			lastSeq = row.seq;
			checked++;
		}

		cursor = rows[rows.length - 1].seq;
	}
}

/**
 * The chain state an archive is verified against.
 *
 * The same two columns `AuditAnchor` holds, and for the same reason — an archived chain's oldest row
 * links to an event that is not in the file with it — but not read from an `AuditAnchor` row, because
 * an archive has no such table. `lib/archive/rotate.ts` passes the live anchor as it stood before the
 * rows left, which at that moment is exactly what precedes the archive's oldest row.
 */
export interface ArchiveAnchor {
	/** `seq` of the last event swept or archived before this file's oldest row. */
	seq: number;
	/** That event's `hash`, which this file's oldest row's `prevHash` must equal. */
	hash: string;
}

/**
 * An archived audit row exactly as SQLite hands it back.
 *
 * Snake-case because an archive is written with the same DDL as `audit_events`, and `at` as text
 * because that is the encoding `lib/archive/rotate.ts` writes: ISO-8601 with an explicit offset, the
 * same form the live database stores, so reading one back never involves guessing.
 */
interface StoredAuditRow {
	seq: number;
	at: string;
	actor_kind: string;
	actor_user_id: string | null;
	actor_name: string | null;
	actor_email: string | null;
	api_key_id: string | null;
	api_key_name: string | null;
	action: string;
	target_kind: string | null;
	target_id: string | null;
	target_label: string | null;
	outcome: string;
	detail: string | null;
	ip_address: string | null;
	user_agent: string | null;
	session_id: string | null;
	prev_hash: string;
	hash: string;
}

/**
 * Presents an archive file to {@link verifyAuditChain} as though it were the audit database.
 *
 * An archived period has to be checkable, or it is a file nobody can trust and the rotation that made
 * it destroyed the only copy that could be. This is what makes that check the *same* check: rather
 * than a second implementation of the hash walk — which is how two implementations come to disagree
 * about a stored contract — the archive is wrapped in the reads {@link AuditChainReader} names, and
 * the one verifier walks it.
 *
 * Read-only in the same deliberate sense as the rest of this module: the object below implements
 * exactly `auditAnchor.findUnique` and the `seq > cursor` form of `auditEvent.findMany`, which is all
 * the walk calls, and nothing that could write. It is a structural stand-in and not a Prisma client,
 * so it is cast rather than typed into place; anything the walk does not call is absent.
 *
 * **`at` comes back as a `Date`, and that is load-bearing.** It is one of the sixteen fields the hash
 * covers, and `hashEvent` serialises a `Date` through `toISOString` — hand the walk the raw stored
 * string and every row recomputes to a different digest and reads as tampered.
 *
 * @param archive an open handle on an archive file; the caller opens and closes it
 * @param anchor what precedes the archive's oldest row, or null when the archive starts at genesis
 * @returns a reader {@link verifyAuditChain} accepts
 */
export function archiveChainReader(archive: Database, anchor: ArchiveAnchor | null): AuditChainReader {
	const select = archive.prepare("SELECT * FROM audit_events WHERE seq > ? ORDER BY seq ASC LIMIT ?");

	const reader = {
		auditAnchor: {
			findUnique: async (): Promise<ArchiveAnchor | null> => anchor,
		},
		auditEvent: {
			findMany: async (args: { where: { seq: { gt: number } }; take: number }) =>
				(select.all(args.where.seq.gt, args.take) as StoredAuditRow[]).map(fromStored),
		},
	};

	return reader as unknown as AuditChainReader;
}

/**
 * Restores an archived row to the shape the chain was hashed over.
 *
 * The return type is {@link ChainedFields} plus the three chain columns rather than a hand-written
 * list, so a field added to the canonical form is a type error here instead of a row that quietly
 * hashes to something else.
 *
 * @param row the row as stored
 * @returns the same row in the client's naming, with `at` back as a moment
 */
function fromStored(row: StoredAuditRow): ChainedFields & { seq: number; prevHash: string; hash: string } {
	return {
		seq: row.seq,
		at: new Date(row.at),
		actorKind: row.actor_kind,
		actorUserId: row.actor_user_id,
		actorName: row.actor_name,
		actorEmail: row.actor_email,
		apiKeyId: row.api_key_id,
		apiKeyName: row.api_key_name,
		action: row.action,
		targetKind: row.target_kind,
		targetId: row.target_id,
		targetLabel: row.target_label,
		outcome: row.outcome,
		detail: row.detail,
		ipAddress: row.ip_address,
		userAgent: row.user_agent,
		sessionId: row.session_id,
		prevHash: row.prev_hash,
		hash: row.hash,
	};
}

/**
 * Renders a verification result for an operator.
 *
 * Beside the type rather than inside `scripts/audit-verify.ts` so it can be tested without
 * importing a script — importing one runs its `main()`, which would connect and disconnect the
 * shared Prisma client in the middle of a suite.
 *
 * @param result what the walk found
 * @returns the lines to print
 */
export function describeVerification(result: ChainVerification): string {
	if (result.ok && result.checked === 0) {
		return "There are no audit events to verify.";
	}
	if (result.ok) {
		return `The audit chain is intact: ${result.checked} events verified, seq ${result.firstSeq} through ${result.lastSeq}.`;
	}
	return [
		`THE AUDIT CHAIN IS BROKEN at seq ${result.brokenAt} (${result.reason}).`,
		`${result.checked} events before it verified.`,
		"",
		"This means the record was changed after it was written. Nothing here can repair it, and",
		`nothing should: seq ${result.brokenAt} is where an investigation starts.`,
	].join("\n");
}
