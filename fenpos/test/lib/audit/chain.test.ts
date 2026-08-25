import { describe, expect, it } from "vitest";
import { type ChainedFields, canonicalise, GENESIS_HASH, hashEvent } from "@/lib/audit/chain";

/**
 * The canonical form and the digest over it.
 *
 * The digest below is **pinned**, not derived. It was computed once against the field order this
 * module declares, and every `AuditEvent` row ever written on any install carries a hash produced
 * the same way. If a change to this module makes this test fail, the change invalidates stored
 * history: fix the change, never the expected value.
 */
describe("hashEvent", () => {
	const fields: ChainedFields = {
		at: new Date("2026-08-25T09:00:00.000Z"),
		actorKind: "USER",
		actorUserId: "user-1",
		actorName: "Owner",
		actorEmail: "owner@example.com",
		apiKeyId: null,
		apiKeyName: null,
		action: "auth:sign-in",
		targetKind: null,
		targetId: null,
		targetLabel: null,
		outcome: "SUCCESS",
		detail: null,
		ipAddress: "203.0.113.7",
		userAgent: "vitest",
		sessionId: "session-1",
	};

	it("produces the pinned digest for the pinned row", () => {
		expect(hashEvent(fields, GENESIS_HASH)).toBe("58a6bd3e8dff6815fe6400c7a71dda7f6775ae32be418718a03372a18ee66525");
	});

	it("changes when any covered field changes", () => {
		expect(hashEvent({ ...fields, outcome: "DENIED" }, GENESIS_HASH)).toBe(
			"8409b05ac7d185acd15549a906a0fc02b6ccc2f392f987dd3344fb347bcef3a2",
		);
	});

	it("changes when the predecessor changes", () => {
		const linked = hashEvent(fields, "aa".repeat(32));

		expect(linked).not.toBe(hashEvent(fields, GENESIS_HASH));
	});

	it("names every field it covers, in order", () => {
		const lines = canonicalise(fields).split("\n");

		expect(lines.map((line) => line.slice(0, line.indexOf("=")))).toEqual([
			"at",
			"actorKind",
			"actorUserId",
			"actorName",
			"actorEmail",
			"apiKeyId",
			"apiKeyName",
			"action",
			"targetKind",
			"targetId",
			"targetLabel",
			"outcome",
			"detail",
			"ipAddress",
			"userAgent",
			"sessionId",
		]);
	});

	it("cannot be forged by a value that looks like a field separator", () => {
		// The reason values are JSON-encoded rather than interpolated: a `detail` carrying a newline
		// and an `=` would otherwise be indistinguishable from two fields.
		const sneaky = hashEvent({ ...fields, detail: '"\noutcome="DENIED' }, GENESIS_HASH);

		expect(sneaky).not.toBe(hashEvent({ ...fields, outcome: "DENIED" }, GENESIS_HASH));
	});

	it("starts the chain from a constant nothing can collide with", () => {
		expect(GENESIS_HASH).toBe("0".repeat(64));
	});
});
