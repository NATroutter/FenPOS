import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import {
	clearAllowlist,
	clearTwoFactor,
	listAccounts,
	type RecoverableAccount,
	RecoveryRefusal,
	resetPassword,
	unlockAccount,
} from "../lib/auth/recover";

/**
 * A shell for an install nobody can sign in to.
 *
 * Usage:
 *   pnpm auth:recover --list
 *   pnpm auth:recover --reset-password <email>
 *   pnpm auth:recover --clear-2fa <email>
 *   pnpm auth:recover --unlock <email>
 *   pnpm auth:recover --clear-allowlist
 *
 * With no email and first-run setup permanently sealed, a forgotten superuser password would
 * otherwise brick the install for good; `auth.require2fa` can do the same to an administrator who
 * loses both their phone and their recovery codes. This exists so filesystem access — not a session,
 * not a panel permission — is enough to recover either.
 *
 * That is also its entire safety argument: running this requires reading `DATABASE_URL` and opening
 * the database file directly, which is filesystem access strictly stronger than anything the panel
 * itself checks. It grants nothing to anyone who could not already read the database directly, and
 * everything it does is re-derivable by that same reader with a SQL client instead of this script.
 *
 * All the actual work — resolving an account, changing it, writing the audit row that describes the
 * change — lives in `lib/auth/recover.ts`, tested on its own against a real database. This module is
 * only argument parsing (tested here, in `parseRecoveryArgs`, because a misread command acts on the
 * wrong account) and the printing and process shape (`try`/`finally`, `process.exitCode`) that turns
 * that module's exports into a runnable command, modelled on `scripts/audit-verify.ts`.
 */

/** The commands `parseRecoveryArgs` can produce, plus the two outcomes that are not a command. */
export type RecoveryCommand =
	| { kind: "help" }
	| { kind: "error"; message: string }
	| { kind: "list" }
	| { kind: "reset-password"; email: string }
	| { kind: "clear-2fa"; email: string }
	| { kind: "unlock"; email: string }
	| { kind: "clear-allowlist" };

/** Printed for `--help`, and for empty argv, and ahead of a parse error. */
const USAGE = `Usage:
  pnpm auth:recover --list
  pnpm auth:recover --reset-password <email>
  pnpm auth:recover --clear-2fa <email>
  pnpm auth:recover --unlock <email>
  pnpm auth:recover --clear-allowlist
`;

/** The flags in {@link USAGE} that take no email argument. */
const NO_ARGUMENT_FLAGS = {
	"--list": "list",
	"--clear-allowlist": "clear-allowlist",
} as const;

/** The flags in {@link USAGE} that require an email address as the following argument. */
const EMAIL_FLAGS = {
	"--reset-password": "reset-password",
	"--clear-2fa": "clear-2fa",
	"--unlock": "unlock",
} as const;

/**
 * Reads `process.argv.slice(2)` into a single command, or explains why it could not.
 *
 * This is the one part of the script worth testing in isolation: everything downstream of a
 * successfully parsed command acts on an account, so a command misread here is an operation aimed at
 * the wrong address rather than a crash. Every branch below either recognises a flag it knows or
 * returns `{ kind: "error" }` — nothing is dropped silently, because a silently-ignored typo (
 * `--clear-allowlst` for `--clear-allowlist`) is exactly how an emergency command becomes a no-op at
 * the moment it is needed most.
 *
 * @param argv the arguments after the script name, i.e. `process.argv.slice(2)`
 * @returns the single command `argv` names, `{ kind: "help" }` for no arguments, or
 *   `{ kind: "error" }` with a message explaining what was wrong
 */
export function parseRecoveryArgs(argv: string[]): RecoveryCommand {
	if (argv.length === 0) {
		return { kind: "help" };
	}

	const commands: RecoveryCommand[] = [];
	let index = 0;

	while (index < argv.length) {
		const arg = argv[index];

		if (arg === "--help") {
			return { kind: "help" };
		}

		if (arg in NO_ARGUMENT_FLAGS) {
			commands.push({ kind: NO_ARGUMENT_FLAGS[arg as keyof typeof NO_ARGUMENT_FLAGS] });
			index += 1;
			continue;
		}

		if (arg in EMAIL_FLAGS) {
			const email = argv[index + 1];
			// Not just "missing": an email-looking flag's argument slot swallowed by the next flag
			// (`--reset-password --list`) must refuse too, rather than treat "--list" as an address.
			if (!email || email.startsWith("--")) {
				return { kind: "error", message: `${arg} requires an email address` };
			}
			commands.push({ kind: EMAIL_FLAGS[arg as keyof typeof EMAIL_FLAGS], email } as RecoveryCommand);
			index += 2;
			continue;
		}

		return { kind: "error", message: `unrecognized argument: ${arg}` };
	}

	if (commands.length > 1) {
		return { kind: "error", message: "give exactly one command at a time" };
	}

	// Unreachable in practice — every loop iteration above either returns or pushes a command before
	// the `argv.length === 0` guard already handled the only way to reach the loop with nothing to
	// push — but a defensive fallback to "help" is a safer failure than a runtime crash on `[0]`.
	return commands[0] ?? { kind: "help" };
}

/**
 * Formats accounts as a table an operator can read at a glance, widest column first.
 *
 * @param accounts every account, as {@link listAccounts} returns them
 * @returns the table, newline-terminated, ready for `process.stdout.write`
 */
function formatAccountTable(accounts: RecoverableAccount[]): string {
	if (accounts.length === 0) {
		return "No accounts.\n";
	}

	const headers = ["EMAIL", "NAME", "SUPERUSER", "2FA", "LOCKED UNTIL"];
	const rows = accounts.map((account) => [
		account.email,
		account.name,
		account.isSuperuser ? "yes" : "no",
		account.twoFactorEnabled ? "yes" : "no",
		account.lockedUntil ? account.lockedUntil.toISOString() : "-",
	]);

	const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column].length)));

	const formatRow = (cells: string[]): string =>
		cells
			.map((cell, column) => cell.padEnd(widths[column]))
			.join("  ")
			.trimEnd();

	return [formatRow(headers), ...rows.map(formatRow)].join("\n").concat("\n");
}

/**
 * Builds the client this script's operations run through.
 *
 * Modelled on `scripts/audit-verify.ts`, which explains why: `lib/db.ts` begins with
 * `import "server-only"` and throws outside Next, so a script running out here — the entire point of
 * this command existing — builds its own client instead. `dotenv/config`, imported for its side
 * effect at the top of this module, is what puts `DATABASE_URL` in the environment out here.
 *
 * @returns a client backed by the database at `DATABASE_URL`
 */
function buildPrismaClient(): PrismaClient {
	return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "" }) });
}

/**
 * Runs the parsed command against a real database, printing its result and setting the exit code.
 *
 * **`--reset-password` prints the minted password before doing anything else that could throw.**
 * By the time `resetPassword` has returned, the credential is already changed and the audit row
 * already written — there is nothing left to roll back. If a later step in this function threw before
 * the password reached the operator's screen, the account would be left with a password nobody has,
 * which is a second lockout instead of a recovery. Printing it as the very next statement after the
 * `await` is what rules that out.
 *
 * **A refusal prints differently from an unexpected failure.** `error instanceof RecoveryRefusal`
 * covers the one kind of failure `lib/auth/recover.ts` authored a message for on purpose — for
 * instance, an address whose account has no password credential to reset — and that message is
 * printed as-is. Anything else is unchanged from whatever the client or the runtime threw, which
 * `lib/auth/recover.ts`'s own comments note can embed argument values (a `PrismaClientValidationError`
 * on the credential update, for one, can embed the freshly minted hash); this prints only "check the
 * logs" for that case, never the exception's own message, for the same reason
 * `UNEXPECTED_FAILURE_REASON` keeps it out of the audit row.
 *
 * @param command the command `parseRecoveryArgs` produced; only the five action kinds reach here
 */
async function runCommand(command: Exclude<RecoveryCommand, { kind: "help" } | { kind: "error" }>): Promise<void> {
	const prisma = buildPrismaClient();

	try {
		switch (command.kind) {
			case "list": {
				const accounts = await listAccounts(prisma);
				process.stdout.write(formatAccountTable(accounts));
				return;
			}
			case "reset-password": {
				const minted = await resetPassword(prisma, command.email);
				process.stdout.write(`${minted}\n`);
				process.stdout.write(
					"This password is shown once and cannot be recovered; the account must set a new one at " +
						"its next sign-in.\n",
				);
				return;
			}
			case "clear-2fa": {
				await clearTwoFactor(prisma, command.email);
				process.stdout.write(`Two-factor enrolment cleared for '${command.email}'.\n`);
				return;
			}
			case "unlock": {
				await unlockAccount(prisma, command.email);
				process.stdout.write(`Lockout cleared for '${command.email}'.\n`);
				return;
			}
			case "clear-allowlist": {
				await clearAllowlist(prisma);
				process.stdout.write("Address allowlist cleared.\n");
				return;
			}
			default: {
				// Exhaustiveness guard, not a reachable branch: every kind `runCommand` is typed to accept
				// returns above. A sixth `RecoveryCommand` kind added later without a case here would
				// otherwise fall off the end of this `try` silently — exiting 0 having done nothing, the
				// same failure class `parseRecoveryArgs`' own comment calls out for `--clear-allowlst`.
				// Assigning to `never` turns that into a compile error at the moment the case is missing,
				// instead of a silent no-op discovered during an emergency.
				const exhaustive: never = command;
				throw new Error(`unhandled recovery command: ${JSON.stringify(exhaustive)}`);
			}
		}
	} catch (error) {
		if (error instanceof RecoveryRefusal) {
			process.stderr.write(`${error.message}\n`);
		} else {
			process.stderr.write("Unexpected failure; check the logs.\n");
		}
		process.exitCode = 1;
	} finally {
		await prisma.$disconnect();
	}
}

/**
 * Entry point: parses `process.argv`, then either prints usage, refuses, or runs a command.
 *
 * Not called at module scope. `test/scripts/auth-recover.test.ts` imports this module to exercise
 * `parseRecoveryArgs` directly, and a bare `void main()` alongside that export would run the whole
 * command — including opening a database connection — as a side effect of that import. Unlike
 * `scripts/audit-verify.ts`, which is safe to call at module scope precisely because nothing imports
 * it, this module is imported by a test, so `main()` only runs from the guard below.
 */
async function main(): Promise<void> {
	const command = parseRecoveryArgs(process.argv.slice(2));

	if (command.kind === "help") {
		process.stdout.write(USAGE);
		return;
	}

	if (command.kind === "error") {
		process.stderr.write(`${command.message}\n\n${USAGE}`);
		process.exitCode = 1;
		return;
	}

	await runCommand(command);
}

// True when this file is the one `tsx` (or `node`) was invoked on directly, and false when it is
// only imported — the traditional Node "is this the entry module" check, chosen over the newer
// `import.meta.main` because that field is not available in this project's Node 22 runtime. Both
// sides go through `resolve()` before comparing: an exact string compare between
// `fileURLToPath(import.meta.url)` and `process.argv[1]` agrees only when both happen to be
// spelled identically — an 8.3 short path (`NATROU~1`) or a drive-letter case difference is enough
// to make them disagree even though they name the same file. When that happens the guard used to
// fail *silently*: `main()` never ran, nothing printed, exit code 0 — the same failure class this
// script's own argument parser exists to rule out for a mistyped flag.
const isEntryModule =
	process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isEntryModule) {
	void main();
}
