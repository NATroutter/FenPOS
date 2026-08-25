import { describe, expect, it } from "vitest";
import { REDACTED_KEYS, REDACTION_MARKER, redact } from "@/lib/redact";

/**
 * The one list of field names never written down.
 *
 * Shared by the process logger and the audit writer, which is the property under test here as much
 * as the redaction itself: a second copy of this list would drift the first time somebody added a
 * secret-shaped field to one of them.
 */
describe("redact", () => {
	it("replaces a listed key's value wherever it appears", () => {
		const result = redact({ email: "owner@example.com", password: "hunter2" }) as Record<string, unknown>;

		expect(result.email).toBe("owner@example.com");
		expect(result.password).toBe(REDACTION_MARKER);
	});

	it("matches keys ignoring case and separators", () => {
		const result = redact({ api_key: "k", APIKEY: "k", apiKey: "k" }) as Record<string, unknown>;

		expect(Object.values(result)).toEqual([REDACTION_MARKER, REDACTION_MARKER, REDACTION_MARKER]);
	});

	it("recurses into nested objects and arrays", () => {
		const result = redact({ outer: [{ setupKey: "AAAA-BBBB" }] }) as { outer: Record<string, unknown>[] };

		expect(result.outer[0].setupKey).toBe(REDACTION_MARKER);
	});

	it("bounds recursion so a deeply nested value cannot overflow the stack", () => {
		let nested: Record<string, unknown> = { end: "value" };
		for (let depth = 0; depth < 20; depth++) {
			nested = { nested };
		}

		expect(() => redact(nested)).not.toThrow();
	});

	it("covers the password fields the auth surface actually produces", () => {
		// Exact-match, not substring: `newPassword` normalises to `newpassword`, which `password`
		// does not cover. Each of these is a field name that exists in this codebase's auth actions.
		for (const key of ["newpassword", "currentpassword", "confirmpassword", "setupkey"]) {
			expect(REDACTED_KEYS).toContain(key);
		}
	});
});
