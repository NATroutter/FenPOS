import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import { CLI_ACTOR } from "@/lib/audit/audit-log";
import { GENESIS_HASH } from "@/lib/audit/chain";
import { NO_PROVENANCE } from "@/lib/audit/provenance";
import { verifyAuditChain } from "@/lib/audit/verify";
import { prisma } from "@/lib/db";

/**
 * The append, driven the way a script drives it: with a client passed in.
 *
 * These assert the chain's own properties rather than the writer's internals, because the chain is
 * the stored contract and the writer is not.
 */
describe("appendAuditEvent", () => {
	beforeEach(async () => {
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
		vi.restoreAllMocks();
	});

	it("links the first row to the genesis hash", async () => {
		await appendAuditEvent(prisma, {
			action: "recover:test",
			outcome: "SUCCESS",
			actor: CLI_ACTOR,
			provenance: NO_PROVENANCE,
		});

		const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "asc" } });
		expect(row.prevHash).toBe(GENESIS_HASH);
		expect(row.actorKind).toBe("CLI");
	});

	it("chains each row to the one before it", async () => {
		for (const action of ["recover:one", "recover:two", "recover:three"]) {
			await appendAuditEvent(prisma, {
				action,
				outcome: "SUCCESS",
				actor: CLI_ACTOR,
				provenance: NO_PROVENANCE,
			});
		}

		const rows = await prisma.auditEvent.findMany({ orderBy: { seq: "asc" } });
		expect(rows).toHaveLength(3);
		expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
		expect(rows[2]?.prevHash).toBe(rows[1]?.hash);
	});

	it("produces a chain the verifier accepts", async () => {
		for (const action of ["recover:one", "recover:two"]) {
			await appendAuditEvent(prisma, {
				action,
				outcome: "SUCCESS",
				actor: CLI_ACTOR,
				provenance: NO_PROVENANCE,
			});
		}

		expect((await verifyAuditChain(prisma)).ok).toBe(true);
	});

	it("interleaves with rows the panel wrote, in one unbroken chain", async () => {
		// The real mixture: a script and a request writing to the same record. If the two writers
		// disagreed about the chain, this is where it would show.
		const { recordAudit } = await import("@/lib/audit/audit-log");
		await recordAudit({
			action: "recover:panel-side",
			outcome: "SUCCESS",
			actor: CLI_ACTOR,
			provenance: NO_PROVENANCE,
		});
		await appendAuditEvent(prisma, {
			action: "recover:script-side",
			outcome: "SUCCESS",
			actor: CLI_ACTOR,
			provenance: NO_PROVENANCE,
		});

		expect((await verifyAuditChain(prisma)).ok).toBe(true);
	});

	it("rejects rather than swallows when the write fails", async () => {
		// The contract the CLI is written against: `audit-log.ts`'s `appendEvent` is what swallows
		// and logs, and it can only do that because this rejects instead of doing it itself.
		vi.spyOn(prisma.auditEvent, "create").mockRejectedValue(new Error("disk is full"));

		await expect(
			appendAuditEvent(prisma, {
				action: "recover:doomed",
				outcome: "SUCCESS",
				actor: CLI_ACTOR,
				provenance: NO_PROVENANCE,
			}),
		).rejects.toThrow("disk is full");
	});

	it("defaults to no provenance when the caller passes none", async () => {
		// Every other case in this file passes `provenance` explicitly; this is the one that reaches
		// the `?? NO_PROVENANCE` fallback the CLI actually relies on.
		await appendAuditEvent(prisma, { action: "recover:no-provenance", outcome: "SUCCESS", actor: CLI_ACTOR });

		const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "asc" } });
		expect(row.ipAddress).toBeNull();
		expect(row.userAgent).toBeNull();
		expect(row.sessionId).toBeNull();
	});
});
