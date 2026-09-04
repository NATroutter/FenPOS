import { beforeEach, describe, expect, it } from "vitest";
import { recordAudit, SYSTEM_ACTOR } from "@/lib/audit/audit-log";
import { describeVerification, verifyAuditChain } from "@/lib/audit/verify";
import { auditDb } from "@/lib/db";

/**
 * Proving the record has not been edited.
 *
 * The threat this guards against: an attacker who has obtained superuser credentials, has direct
 * database access, and wants to erase what they did. Each test below is one of the three edits such
 * a person would make, and asserts the exact `seq` at which the chain gives them away.
 */
describe("verifyAuditChain", () => {
	beforeEach(async () => {
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
		await auditDb.auditEpoch.deleteMany({});

		for (const action of ["test:one", "test:two", "test:three", "test:four"]) {
			await recordAudit({ action, outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		}
	});

	it("confirms an untouched chain", async () => {
		const result = await verifyAuditChain(auditDb);

		expect(result.ok).toBe(true);
		expect(result).toMatchObject({ checked: 4 });
	});

	it("confirms an empty table", async () => {
		await auditDb.auditEvent.deleteMany({});

		expect(await verifyAuditChain(auditDb)).toMatchObject({ ok: true, checked: 0, firstSeq: null, lastSeq: null });
	});

	it("detects an altered row at that row", async () => {
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		await auditDb.auditEvent.update({ where: { seq: rows[1].seq }, data: { action: "test:innocent" } });

		expect(await verifyAuditChain(auditDb)).toMatchObject({
			ok: false,
			brokenAt: rows[1].seq,
			reason: "hash-mismatch",
		});
	});

	it("detects a removed row at its successor", async () => {
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		await auditDb.auditEvent.delete({ where: { seq: rows[1].seq } });

		// The gap in `seq` is the symptom; the successor still claiming a predecessor that no longer
		// precedes it is what actually detects the removal.
		expect(await verifyAuditChain(auditDb)).toMatchObject({
			ok: false,
			brokenAt: rows[2].seq,
			reason: "link-mismatch",
		});
	});

	it("detects a row inserted out of order", async () => {
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		// A forged row cannot claim an existing predecessor — `prev_hash` is unique — so the only
		// insert available is one claiming a hash nothing has, which breaks the link at itself.
		await auditDb.auditEvent.create({
			data: {
				at: new Date(),
				actorKind: "SYSTEM",
				action: "test:forged",
				outcome: "SUCCESS",
				prevHash: "ff".repeat(32),
				hash: "ee".repeat(32),
			},
		});

		const result = await verifyAuditChain(auditDb);
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ brokenAt: rows[3].seq + 1 });
	});

	it("verifies from the anchor when history has been swept", async () => {
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		await auditDb.auditAnchor.create({ data: { id: 1, seq: rows[1].seq, hash: rows[1].hash } });
		await auditDb.auditEvent.deleteMany({ where: { seq: { lte: rows[1].seq } } });

		expect(await verifyAuditChain(auditDb)).toMatchObject({ ok: true, checked: 2, firstSeq: rows[2].seq });
	});

	it("detects an anchor that does not match the oldest retained row", async () => {
		const rows = await auditDb.auditEvent.findMany({ orderBy: { seq: "asc" } });
		await auditDb.auditAnchor.create({ data: { id: 1, seq: rows[1].seq, hash: "not-what-was-swept" } });
		await auditDb.auditEvent.deleteMany({ where: { seq: { lte: rows[1].seq } } });

		expect(await verifyAuditChain(auditDb)).toMatchObject({
			ok: false,
			brokenAt: rows[2].seq,
			reason: "anchor-mismatch",
		});
	});
});

/**
 * What the operator reads.
 *
 * Worth testing rather than leaving to the command, because this text is read on the worst day the
 * install ever has — and a report that says "failed" without saying where sends somebody to the
 * database with a query they have to invent.
 */
describe("describeVerification", () => {
	it("confirms a whole chain with the range it covered", () => {
		const text = describeVerification({
			ok: true,
			checked: 1204,
			archived: 0,
			live: 1204,
			firstSeq: 41,
			lastSeq: 1244,
		});

		expect(text).toContain("1204");
		expect(text).toContain("41");
		expect(text).toContain("1244");
	});

	it("says where the events it verified were read from", () => {
		const text = describeVerification({
			ok: true,
			checked: 1204,
			archived: 900,
			live: 304,
			firstSeq: 1,
			lastSeq: 1204,
		});

		// Always stated, including the `0 from archives` above: a directory named wrongly reads as an
		// intact chain, and this split is the only part of the output that says what was actually walked.
		expect(text).toContain("900 from archives");
		expect(text).toContain("304 live");
	});

	it("says so when there is nothing to check", () => {
		expect(
			describeVerification({ ok: true, checked: 0, archived: 0, live: 0, firstSeq: null, lastSeq: null }),
		).toContain("no audit events");
	});

	it("reports an unverifiable prefix as a fact rather than as an accusation", () => {
		const text = describeVerification({
			ok: "incomplete",
			checked: 40,
			archived: 30,
			live: 10,
			verifiedFrom: 61,
			firstSeq: 61,
			lastSeq: 100,
		});

		// "from seq 61", not "seq 61": the whole-chain branch also names a first seq, so an assertion on
		// the bare number stays green when this shape falls through to it — `"incomplete"` is truthy.
		expect(text).toContain("intact from seq 61");
		expect(text).toContain("30 from archives");
		expect(text).toContain("They are simply gone");
		// The whole reason the third state exists. This text is read by an operator whose retention
		// setting did exactly what it was configured to do, and the failure vocabulary would tell them
		// somebody had altered their record.
		expect(text).not.toContain("BROKEN");
		expect(text).not.toContain("changed after it was written");
	});

	it("does not read an incomplete chain that verified nothing as an empty record", () => {
		const text = describeVerification({
			ok: "incomplete",
			checked: 0,
			archived: 0,
			live: 0,
			verifiedFrom: 61,
			firstSeq: null,
			lastSeq: null,
		});

		// The empty-record branch is tested first and `"incomplete"` is a truthy value of `ok`, so a
		// `result.ok && result.checked === 0` guard swallows this shape and answers "there are no audit
		// events to verify" about a record that has an unverifiable prefix in front of it. Goes red the
		// moment that guard loses its `=== true`.
		expect(text).not.toContain("no audit events");
		expect(text).toContain("seq 61");
	});

	it("names the exact sequence number where the chain breaks", () => {
		const text = describeVerification({ ok: false, checked: 88, brokenAt: 89, reason: "hash-mismatch" });

		expect(text).toContain("89");
		expect(text).toContain("hash-mismatch");
	});

	it("prints the detail a join failure carries, which names both sides", () => {
		const text = describeVerification({
			ok: false,
			checked: 12,
			brokenAt: 12,
			reason: "archive-join-mismatch",
			detail: "The archives end at seq 11 (hash aaa), but the anchor names seq 12 (hash bbb).",
		});

		// Without this line the operator is told two records disagree and not which two values.
		expect(text).toContain("hash aaa");
		expect(text).toContain("hash bbb");
	});
});
