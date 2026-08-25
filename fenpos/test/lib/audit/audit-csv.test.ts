import { describe, expect, it } from "vitest";
import { toAuditCsv } from "@/lib/audit/audit-csv";
import type { AuditEventSummary } from "@/lib/audit/audit-query";

/** A row with everything populated, which each test then varies one field of. */
function event(overrides: Partial<AuditEventSummary> = {}): AuditEventSummary {
	return {
		seq: 1,
		at: "2026-08-26T09:00:00.000Z",
		actor: "Ada",
		actorKind: "USER",
		actorUserId: "u1",
		actorEmail: "ada@example.com",
		action: "devices:delete",
		outcome: "SUCCESS",
		targetKind: "device",
		targetId: "d1",
		targetLabel: "Kitchen",
		detail: '{"port":"COM3"}',
		ipAddress: "203.0.113.50",
		userAgent: "Firefox",
		...overrides,
	};
}

/**
 * The export, and in particular its escaping.
 *
 * An exported audit record is a document built from hostile input: `actorName` and `actorEmail` come
 * from whatever was typed at a sign-in, `targetLabel` from a name somebody chose, `detail` from an
 * action's parameters. It is then opened in a spreadsheet, which executes some of those strings.
 */
describe("toAuditCsv", () => {
	it("writes a header row", () => {
		expect(toAuditCsv([]).trim()).toBe(
			"seq,at,actor,actorKind,actorUserId,actorEmail,action,outcome,targetKind,targetId,targetLabel,ipAddress,userAgent,detail",
		);
	});

	it("writes one line per event", () => {
		const csv = toAuditCsv([event({ seq: 1 }), event({ seq: 2 })]);

		expect(csv.trimEnd().split("\r\n")).toHaveLength(3);
	});

	it("quotes a field holding a comma", () => {
		const csv = toAuditCsv([event({ targetLabel: "Kitchen, back" })]);

		expect(csv).toContain('"Kitchen, back"');
	});

	it("doubles a quote inside a quoted field", () => {
		const csv = toAuditCsv([event({ targetLabel: 'The "good" printer' })]);

		expect(csv).toContain('"The ""good"" printer"');
	});

	it("quotes a field holding a newline rather than letting it end the row", () => {
		const csv = toAuditCsv([event({ userAgent: "one\ntwo" })]);

		expect(csv).toContain('"one\ntwo"');
		// Two rows, not three: the embedded newline is inside a quoted field, so it does not split one.
		expect(csv.trimEnd().split("\r\n")).toHaveLength(2);
	});

	it("defuses a leading = so a spreadsheet does not execute it", () => {
		const csv = toAuditCsv([event({ actor: "=1+1" })]);

		expect(csv).toContain("'=1+1");
	});

	it("defuses every character a spreadsheet treats as a formula", () => {
		for (const dangerous of ["=cmd", "+1", "-1", "@SUM(A1)"]) {
			expect(toAuditCsv([event({ actor: dangerous })])).toContain(`'${dangerous}`);
		}
	});

	it("defuses a formula that also needs quoting, with the apostrophe inside the quotes", () => {
		// Order matters: defusing after quoting would put the apostrophe outside, where it changes what
		// the field is rather than what it starts with.
		const csv = toAuditCsv([event({ targetLabel: "=SUM(A1,B1)" })]);

		expect(csv).toContain('"\'=SUM(A1,B1)"');
	});

	it("leaves an ordinary value alone", () => {
		const csv = toAuditCsv([event({ actor: "Ada" })]);

		expect(csv).toContain(",Ada,");
		expect(csv).not.toContain("'Ada");
	});

	it("writes an empty field for a null", () => {
		const csv = toAuditCsv([event({ ipAddress: null, detail: null })]);

		expect(csv.trimEnd().endsWith(",")).toBe(true);
	});
});
