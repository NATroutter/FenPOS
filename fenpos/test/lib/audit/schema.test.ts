import { beforeEach, describe, expect, it } from "vitest";
import { auditDb } from "@/lib/db";

/**
 * The two tables, and the one constraint the concurrency design rests on.
 *
 * `prevHash` being unique is not a tidiness measure — it is the mechanism by which two writers
 * cannot fork the chain. A migration that dropped that index would leave every other test in this
 * phase passing and the guarantee gone, so it is asserted directly against the database.
 *
 * That database is now `audit.db` rather than the application's, which is why these run against
 * `auditDb`: moving a table is exactly the kind of change that can carry the columns across and
 * leave an index behind, and the constraint is what the concurrency design rests on rather than
 * the column list.
 */
describe("audit schema", () => {
	beforeEach(async () => {
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
	});

	/** Builds a row with everything the columns require and nothing they do not. */
	function event(prevHash: string, hash: string) {
		return {
			at: new Date("2026-08-25T09:00:00.000Z"),
			actorKind: "SYSTEM",
			action: "test:write",
			outcome: "SUCCESS",
			prevHash,
			hash,
		};
	}

	it("assigns increasing sequence numbers", async () => {
		const first = await auditDb.auditEvent.create({ data: event("a", "b") });
		const second = await auditDb.auditEvent.create({ data: event("b", "c") });

		expect(second.seq).toBeGreaterThan(first.seq);
	});

	it("refuses a second row claiming the same predecessor", async () => {
		await auditDb.auditEvent.create({ data: event("a", "b") });

		// The fork the design forbids: two rows both saying "I follow a".
		await expect(auditDb.auditEvent.create({ data: event("a", "different") })).rejects.toThrow();
	});

	it("refuses two rows with the same hash", async () => {
		await auditDb.auditEvent.create({ data: event("a", "b") });

		await expect(auditDb.auditEvent.create({ data: event("z", "b") })).rejects.toThrow();
	});

	it("holds one anchor row", async () => {
		await auditDb.auditAnchor.create({ data: { id: 1, seq: 40, hash: "h" } });

		await expect(auditDb.auditAnchor.create({ data: { id: 1, seq: 41, hash: "i" } })).rejects.toThrow();
	});
});
