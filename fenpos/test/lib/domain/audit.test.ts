import { describe, expect, it } from "vitest";
import { ActorKind, AuditOutcome } from "@/lib/domain/audit";

/**
 * The closed sets the audit table stores as TEXT.
 *
 * These are a stored contract: rows already written carry these exact strings, and their hashes
 * cover them. Renaming one silently invalidates every hash over every row that holds it.
 */
describe("audit value sets", () => {
	it("names every kind of actor the record can attribute an event to", () => {
		expect(ActorKind.values).toEqual(["USER", "API_KEY", "SYSTEM", "SETUP", "CLI"]);
	});

	it("names the three outcomes an event can have", () => {
		expect(AuditOutcome.values).toEqual(["SUCCESS", "DENIED", "FAILURE"]);
	});

	it("narrows a string read back from the database", () => {
		expect(ActorKind.is("USER")).toBe(true);
		expect(ActorKind.is("user")).toBe(false);
		expect(AuditOutcome.is("REFUSED")).toBe(false);
	});
});
