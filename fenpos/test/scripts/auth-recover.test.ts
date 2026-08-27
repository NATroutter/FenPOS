import { describe, expect, it } from "vitest";
import { RecoveryRefusal } from "@/lib/auth/recover";
import { formatFailure, parseRecoveryArgs } from "@/scripts/auth-recover";

/**
 * Argument parsing, and the one line of output an operator has left when something goes wrong.
 *
 * The script's other half — building a client, printing a result, setting an exit code — is a shell
 * over `lib/auth/recover.ts`, which has its own tests against a real database. What can genuinely go
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

	/**
	 * The flag tables are plain object literals, so every name on `Object.prototype` answers `in`.
	 * Before `Object.hasOwn`, each of these parsed as a *known* flag carrying a function as its
	 * `kind`, which then opened a database connection and fell off `runCommand`'s exhaustiveness
	 * guard — an unexpected-failure trace where the documented "unrecognized argument" belongs.
	 */
	it.each([
		"constructor",
		"toString",
		"valueOf",
		"__proto__",
		"hasOwnProperty",
	])("refuses '%s' as an unrecognized argument rather than reading it off the prototype chain", (inherited) => {
		expect(parseRecoveryArgs([inherited])).toEqual({
			kind: "error",
			message: `unrecognized argument: ${inherited}`,
		});
	});
});

/**
 * What an operator gets on stderr, which on this script is the whole of what they get.
 *
 * There are no logs here: `lib/logger.ts` is `server-only` and this runs in its own process. A
 * failure the terminal does not describe is a failure nobody can act on, on an install where the
 * panel is by definition unreachable.
 */
describe("formatFailure", () => {
	it("prints an authored refusal's own message, and nothing else", () => {
		expect(formatFailure(new RecoveryRefusal("No account found for 'nobody@example.test'."))).toBe(
			"No account found for 'nobody@example.test'.\n",
		);
	});

	it("prints the exception behind an unexpected failure, not only a fixed sentence", () => {
		const error = new Error("SQLITE_READONLY: attempt to write a readonly database");

		const printed = formatFailure(error);

		expect(printed).toContain("Unexpected failure:");
		// The message and a frame from the stack: the message alone does not say which call failed,
		// and this process has nowhere else to record that.
		expect(printed).toContain("SQLITE_READONLY: attempt to write a readonly database");
		expect(printed).toContain("auth-recover.test.ts");
	});

	it("prints a thrown non-Error rather than swallowing it", () => {
		expect(formatFailure("a bare string nobody wrapped")).toContain("a bare string nobody wrapped");
	});
});
