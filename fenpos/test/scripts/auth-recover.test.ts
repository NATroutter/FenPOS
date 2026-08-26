import { describe, expect, it } from "vitest";
import { parseRecoveryArgs } from "@/scripts/auth-recover";

/**
 * Argument parsing only.
 *
 * The script's other half — building a client, printing, setting an exit code — is a shell over
 * `lib/auth/recover.ts`, which has its own tests against a real database. What can genuinely go
 * wrong here is a command being misread, and a misread recovery command acts on the wrong account.
 */
describe("parseRecoveryArgs", () => {
	it("reads a reset with its address", () => {
		expect(parseRecoveryArgs(["--reset-password", "someone@example.test"])).toEqual({
			kind: "reset-password",
			email: "someone@example.test",
		});
	});

	it("refuses a reset with no address rather than guessing one", () => {
		expect(parseRecoveryArgs(["--reset-password"]).kind).toBe("error");
	});

	it("reads the commands that take no argument", () => {
		expect(parseRecoveryArgs(["--list"])).toEqual({ kind: "list" });
		expect(parseRecoveryArgs(["--clear-allowlist"])).toEqual({ kind: "clear-allowlist" });
	});

	it("treats no arguments as a request for help, not as a command", () => {
		expect(parseRecoveryArgs([]).kind).toBe("help");
	});

	it("refuses two commands at once", () => {
		expect(parseRecoveryArgs(["--list", "--clear-allowlist"]).kind).toBe("error");
	});

	it("refuses an unknown flag rather than ignoring it", () => {
		// Ignoring it is how `--clear-allowlst` silently becomes a no-op in an emergency.
		expect(parseRecoveryArgs(["--clear-allowlst"]).kind).toBe("error");
	});
});
