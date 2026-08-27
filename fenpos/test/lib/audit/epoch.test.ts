import { beforeEach, describe, expect, it } from "vitest";
import { advanceEpoch, claimEpoch, readEpoch } from "@/lib/audit/epoch";
import { auditDb } from "@/lib/db";

/**
 * Where archived history begins, and who is allowed to move it.
 *
 * The epoch's whole value is that it does not move on its own. A marker a timer advanced would be
 * one an attacker could wait for rather than defeat, so `claimEpoch` writing once and never again
 * is the property under test — not merely that a row can be stored.
 */
describe("the audit epoch", () => {
	beforeEach(async () => {
		await auditDb.auditEpoch.deleteMany();
	});

	it("is absent until something claims it", async () => {
		expect(await readEpoch()).toBeNull();
	});

	it("records the seq and prevHash it was claimed with", async () => {
		await claimEpoch(auditDb, 7, "a".repeat(64));

		expect(await readEpoch()).toEqual({ seq: 7, prevHash: "a".repeat(64) });
	});

	it("ignores a second claim, so a later sweep cannot move it", async () => {
		await claimEpoch(auditDb, 7, "a".repeat(64));
		await claimEpoch(auditDb, 99, "b".repeat(64));

		// Goes red if `claimEpoch` upserts: the epoch would follow rotation forward and stop
		// meaning "where archived history begins".
		expect(await readEpoch()).toEqual({ seq: 7, prevHash: "a".repeat(64) });
	});

	it("moves only when advanced explicitly", async () => {
		await claimEpoch(auditDb, 7, "a".repeat(64));
		await advanceEpoch(42, "c".repeat(64));

		expect(await readEpoch()).toEqual({ seq: 42, prevHash: "c".repeat(64) });
	});
});
