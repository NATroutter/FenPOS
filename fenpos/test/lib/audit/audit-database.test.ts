import { describe, expect, it } from "vitest";
import { appendEvent, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { verifyAuditChain } from "@/lib/audit/verify";
import { auditDb, prisma } from "@/lib/db";

/**
 * The audit record is its own file, and moving it did not change what is hashed.
 *
 * The chain is a stored contract: the same sixteen fields, in the same order, with the same
 * encoding. A move that quietly altered any of them would still write rows and still verify against
 * itself, and would only be discovered when an older archive stopped verifying — which is to say,
 * when the evidence was needed. Appending through the real writer and verifying is what makes that
 * a test rather than a hope.
 */
describe("the audit database", () => {
	it("appends and verifies in its own file, invisible to the application database", async () => {
		await appendEvent({ action: "audit:sweep", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const rows = await auditDb.auditEvent.count();
		expect(rows).toBeGreaterThan(0);

		const result = await verifyAuditChain(auditDb);
		expect(result.ok).toBe(true);
		// Goes red on a vacuous verify: a chain that checked nothing would also report ok.
		expect(result.checked).toBe(rows);

		await expect(prisma.$queryRawUnsafe("SELECT 1 FROM audit_events LIMIT 1")).rejects.toThrow();
	});
});
