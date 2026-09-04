import { describe, expect, it } from "vitest";
import { REDACTED_KEYS, REDACTION_MARKER, redact, redactMessage, TRUNCATION_MARKER } from "@/lib/redact";

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

/**
 * The half of the rule that structured fields do not cover.
 *
 * A key-name list is exactly right for `{ password: "…" }` and no use at all for a string that
 * *contains* one. That is not hypothetical here: a database driver builds its error message out of
 * the statement it choked on, so a failed password change reports the arguments it was called with,
 * hash included — and that message is written into an audit row's `detail`, which has no delete
 * path, and into the process log.
 *
 * The opposite failure matters just as much. This runs over every string in every log line and every
 * audit row, so a rule that redacted too eagerly would quietly turn the record it protects into one
 * that no longer says what happened.
 */
describe("redacting a free-text message", () => {
	it("removes a quoted secret from an error a driver built", () => {
		const message =
			'Invalid `prisma.account.update()` invocation: { data: { password: "$argon2id$v=19$m=19456,t=2" } }';

		const result = redactMessage(message);

		expect(result).not.toContain("argon2id");
		expect(result).toContain(REDACTION_MARKER);
		// The rest of the sentence survives: which call failed is the part worth keeping.
		expect(result).toContain("prisma.account.update()");
	});

	it("removes a long unquoted token", () => {
		expect(redactMessage("token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(`token: ${REDACTION_MARKER}`);
	});

	it("catches the separator spellings a message can use", () => {
		for (const written of ["newPassword", "new_password", "NEW-PASSWORD"]) {
			expect(redactMessage(`${written}: "correct-horse-battery-staple"`)).toContain(REDACTION_MARKER);
		}
	});

	it("leaves a short diagnostic value alone", () => {
		// The false positives that made an earlier, looser pattern worse than nothing: both of these
		// are lines with no secret in them, and both stopped saying what went wrong.
		expect(redactMessage("error code: 500")).toBe("error code: 500");
		expect(redactMessage("password: too short")).toBe("password: too short");
	});

	it("leaves ordinary prose alone", () => {
		const message = "The password policy requires 12 characters and this token was refused.";

		expect(redactMessage(message)).toBe(message);
	});

	it("caps a message that would otherwise fill a durable row", () => {
		const result = redactMessage("x".repeat(10_000));

		expect(result.length).toBeLessThan(2_100);
		expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
	});

	it("applies to strings reached through redact, which is how both writers get it", () => {
		// The property that matters: neither the logger nor the audit writer calls `redactMessage`
		// itself, so a secret in prose is only removed if `redact` descends into strings.
		const result = redact({ error: 'failed on password: "$argon2id$v=19$hunter2hunter2"' }) as Record<string, unknown>;

		expect(result.error).not.toContain("argon2id");
	});
});
