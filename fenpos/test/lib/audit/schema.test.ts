import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

/**
 * The two tables, and the one constraint the concurrency design rests on.
 *
 * `prevHash` being unique is not a tidiness measure — it is the mechanism by which two writers
 * cannot fork the chain. A migration that dropped that index would leave every other test in this
 * phase passing and the guarantee gone, so it is asserted directly against the database.
 */
describe("audit schema", () => {
	beforeEach(async () => {
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
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
		const first = await prisma.auditEvent.create({ data: event("a", "b") });
		const second = await prisma.auditEvent.create({ data: event("b", "c") });

		expect(second.seq).toBeGreaterThan(first.seq);
	});

	it("refuses a second row claiming the same predecessor", async () => {
		await prisma.auditEvent.create({ data: event("a", "b") });

		// The fork the design forbids: two rows both saying "I follow a".
		await expect(prisma.auditEvent.create({ data: event("a", "different") })).rejects.toThrow();
	});

	it("refuses two rows with the same hash", async () => {
		await prisma.auditEvent.create({ data: event("a", "b") });

		await expect(prisma.auditEvent.create({ data: event("z", "b") })).rejects.toThrow();
	});

	it("holds one anchor row", async () => {
		await prisma.auditAnchor.create({ data: { id: 1, seq: 40, hash: "h" } });

		await expect(prisma.auditAnchor.create({ data: { id: 1, seq: 41, hash: "i" } })).rejects.toThrow();
	});
});
