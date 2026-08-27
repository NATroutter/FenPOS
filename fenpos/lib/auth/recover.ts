import { randomBytes } from "node:crypto";
import { createLocalAccountIssuer } from "better-auth";
import type { PrismaClient } from "@/generated/prisma/client";
import { appendAuditEvent } from "@/lib/audit/append";
import type { AuditActor, AuditEventInput } from "@/lib/audit/audit-log";
import { NO_PROVENANCE } from "@/lib/audit/provenance-shape";
import { hashPassword } from "@/lib/auth/password";
import { RECOVERY_AUDIT_ACTIONS } from "@/lib/auth/recovery-actions";

/**
 * What `pnpm auth:recover` does to an install nobody can currently sign in to.
 *
 * **No `import "server-only"` here, and none may be added.** A shell script imports this module
 * directly, outside Next entirely — that is the one property phase 8 exists to add, since with no
 * email and first-run setup permanently sealed, a forgotten superuser password would otherwise brick
 * the install for good. `test/lib/audit/append-loads-outside-next.test.ts` spawns a real `tsx`
 * process against this module for exactly that reason: an in-process vitest import would keep
 * passing even if a `server-only` dependency crept in tomorrow, because `vitest.config.mts` aliases
 * that package away for the rest of the suite.
 *
 * **Every operation writes an audit row, including a refusal.** A refused recovery attempt — an
 * address matching no account — is more interesting than a successful one: the successful one has a
 * human standing behind it who can be asked what they did, and a refusal on a box nobody can sign
 * into might be exactly the attempt this record needs to catch. Every write goes through
 * {@link appendAuditEvent}, which throws on failure rather than swallowing it — a recovery tool that
 * silently failed to record a credential reset is the exact failure the audit chain exists to
 * prevent. That row is necessarily written *after* the change it describes rather than inside the same
 * transaction: {@link appendAuditEvent} takes a `PrismaClient`, not a transaction client, because the
 * chain it maintains has to see every writer's commits in order, including ones from other calls
 * interleaved with this one — a transaction client can only see its own. There is therefore a real,
 * if narrow, window between a change committing and its row existing; nothing below closes it, and
 * `resetPassword`'s own doc comment says so again where it matters most.
 *
 * **A caller can tell an actionable refusal from an unexpected failure.** Every exported operation
 * throws {@link RecoveryRefusal} for the one kind of failure it expects — an address matching nothing,
 * or matching an account this operation cannot act on — and anything else unchanged. `RecoveryRefusal`
 * is exported for exactly this: a caller (the CLI, most immediately) can `instanceof` it to decide
 * whether to print "that address is not right" or "something went wrong, check the logs".
 *
 * **This re-expresses, rather than reuses, `lib/auth/account-security.ts`.** That module already
 * implements almost every operation here, but it opens with `import "server-only"` and calls through
 * the bound `prisma` singleton rather than accepting one — both fatal to a script running outside
 * Next. Each function below that mirrors one of its operations says so in its own comment, and keeps
 * the same behaviour: two implementations of "clear a two-factor enrolment" that disagree is a bug
 * waiting for an emergency.
 */

/**
 * Someone with filesystem access, acting outside the panel entirely.
 *
 * The same actor kind `CLI_ACTOR` in `lib/audit/audit-log.ts` names, constructed locally rather than
 * imported: that module opens with `import "server-only"` and binds the `prisma` singleton, both
 * fatal to the one caller this module exists to serve. `AuditActor` itself is imported with `import
 * type`, which is erased at compile time and carries none of that module's runtime weight — only the
 * shared shape crosses, not a second value that could drift from the panel's own. `CLI_ACTOR` would
 * be a one-line hoist into an ungated module (`audit-log.ts` already has `provenance-shape.ts` to
 * follow as precedent); until that happens, this is the same value under a different name.
 */
const CLI_RECOVERY_ACTOR: AuditActor = { kind: "CLI" };

/**
 * Better Auth's identifier for an email-and-password credential.
 *
 * Recomputed here rather than imported from `lib/auth/credential-account.ts`, which also opens with
 * `import "server-only"` — the same problem `CLI_ACTOR` has, above. This does not restate the
 * library's answer as a literal, which would be a second opinion liable to drift from the first; it
 * asks `createLocalAccountIssuer` the identical question (`"credential"`) that module asks, so the
 * two calls cannot disagree about what they get back.
 */
const CREDENTIAL_ISSUER = createLocalAccountIssuer("credential");

/** An account, with the facts an operator needs to choose the right one to recover. */
export interface RecoverableAccount {
	id: string;
	email: string;
	name: string;
	isSuperuser: boolean;
	twoFactorEnabled: boolean;
	/** When its lockout lifts on its own, or null when it is not locked. */
	lockedUntil: Date | null;
	/**
	 * Whether Better Auth's admin plugin refuses this account at the credential layer.
	 *
	 * Listed even though **no command here clears it**, precisely because none does. A ban is one of
	 * the ways an account cannot sign in, and it is the one that survives every operation below: an
	 * operator who resets a banned account's password gets a working credential and a still-unusable
	 * account, with nothing on screen to explain why. The remedy is the Users tab, from an account
	 * that can still reach it.
	 */
	banned: boolean;
}

/**
 * Lists every account, for the CLI to present as a menu.
 *
 * No audit row is written for a list: nothing changed, and reading is not the thing this record
 * exists to catch. The operations below that act on one account are what it is for.
 *
 * @param prisma the client to read through
 * @returns every account, ordered by address
 */
export async function listAccounts(prisma: PrismaClient): Promise<RecoverableAccount[]> {
	const rows = await prisma.user.findMany({
		orderBy: { email: "asc" },
		select: {
			id: true,
			email: true,
			name: true,
			isSuperuser: true,
			twoFactorEnabled: true,
			lockedUntil: true,
			banned: true,
		},
	});

	return rows.map((row) => ({
		id: row.id,
		email: row.email,
		name: row.name,
		// Read through Boolean rather than trusted as typed: SQLite stores these as integers and the
		// column is nullable, and a null must read as "no" — the same reasoning `account-service.ts`
		// and `require-session.ts` both state for the same columns.
		isSuperuser: Boolean(row.isSuperuser),
		twoFactorEnabled: Boolean(row.twoFactorEnabled),
		lockedUntil: row.lockedUntil,
		banned: Boolean(row.banned),
	}));
}

/**
 * Normalises an address the way every other lookup in this codebase does — `lockout.ts`,
 * `account-service.ts`, `setup.ts` — so an operator's address matches however it was capitalised or
 * spaced.
 *
 * @param email the address as given
 * @returns the address to look up and to record
 */
function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * A refusal this module authored itself, thrown from inside a `perform` callback passed to
 * {@link recoverAccount}.
 *
 * The one kind of error whose message reaches a `FAILURE` row's `detail.reason` verbatim — see
 * {@link recordFailure} for why everything else does not. Every message given to this class is
 * therefore text this module wrote deliberately for the row, never a value read back from elsewhere,
 * exactly the discipline `appendAuditEvent`'s callers are expected to hold everywhere else.
 *
 * **Exported for callers, not only for this file.** `pnpm auth:recover`'s CLI is exactly the kind of
 * caller that needs to tell the two apart: `error instanceof RecoveryRefusal` means the operator gave
 * an address that could not be acted on — something to print and let them try again — while anything
 * else is unexpected and worth surfacing as "check the logs" rather than as a normal refusal.
 */
export class RecoveryRefusal extends Error {}

/**
 * What a `FAILURE` row's `detail.reason` says when `perform` threw something other than a
 * {@link RecoveryRefusal}.
 *
 * Never that exception's own `.message`. A `PrismaClientValidationError` on `resetPassword`'s
 * credential update, for one plausible example, embeds the arguments it choked on — which include the
 * freshly minted argon2 hash — and `redact()` only catches secrets it recognises by field *name*; a
 * hash sitting inside a stringified error message would pass straight through it into a table with no
 * edit path. The original error is not lost — {@link recoverAccount} still rethrows it to the caller
 * unchanged — it is only kept out of the one place that cannot be corrected afterwards.
 *
 * The text says exactly that, and nothing more. It named "the command's own output" until the CLI was
 * made to print the exception there, which it was not doing: a row pointing at a terminal, a terminal
 * pointing at logs this process cannot write, and the exception discarded in between. What the row can
 * promise on its own is what `recoverAccount` guarantees by construction for *every* caller — the
 * exception is rethrown, not swallowed — so that is what it says. `scripts/auth-recover.ts`'s
 * `formatFailure` is the caller that turns that guarantee into text an operator can read.
 */
const UNEXPECTED_FAILURE_REASON = "an unexpected error; the exception is rethrown to the caller, never stored here";

/**
 * Writes the `FAILURE` row for a `perform` that threw, after the account was already resolved.
 *
 * Split out of {@link recoverAccount} so the double-failure case has somewhere to keep both errors:
 * if the append itself throws — {@link appendAuditEvent} is designed to, rather than swallow a write
 * it could not make — `error` is not lost behind it. It becomes the thrown result's `cause`, so a
 * caller inspecting the exception still finds what `perform` actually failed with, even though that
 * never reached the row.
 *
 * @param prisma the client to write through
 * @param action which {@link RECOVERY_AUDIT_ACTIONS} this is
 * @param userId the resolved account
 * @param normalizedEmail the address, already normalised
 * @param error what `perform` threw
 * @throws Error combining both failures, only when the append itself also fails
 */
async function recordFailure(
	prisma: PrismaClient,
	action: string,
	userId: string,
	normalizedEmail: string,
	error: unknown,
): Promise<void> {
	const reason = error instanceof RecoveryRefusal ? error.message : UNEXPECTED_FAILURE_REASON;

	try {
		await appendAuditEvent(prisma, {
			action,
			outcome: "FAILURE",
			actor: CLI_RECOVERY_ACTOR,
			target: { kind: "user", id: userId, label: normalizedEmail },
			detail: { reason },
			provenance: NO_PROVENANCE,
		} satisfies AuditEventInput);
	} catch (auditError) {
		throw new Error(
			`Recovery failed for '${normalizedEmail}' and the failure could not be recorded to the audit ` +
				`trail: ${auditError instanceof Error ? auditError.message : String(auditError)}`,
			{ cause: error },
		);
	}
}

/**
 * Runs one recovery operation against the account an address resolves to, writing exactly one audit
 * row per outcome: a `FAILURE` row before throwing when the address matches nothing or `perform`
 * throws, a `SUCCESS` row after `perform` returns.
 *
 * Centralising this is what makes "every operation writes a row, including refusals" true by
 * construction rather than by five separate call sites remembering to do it.
 *
 * **Two things this deliberately does not do, both following from {@link appendAuditEvent}'s own
 * "throws rather than swallows".** First, the `SUCCESS` append runs *after* `perform`'s own
 * `try`/`catch` has already exited — not inside it — so an append failure there propagates as itself
 * rather than being caught and recorded as a contradictory `FAILURE` row for a change that already
 * committed (and, for `resetPassword`, a minted password the caller would then never receive even
 * though it now works). Second, `perform`'s own thrown message reaches the row only when it is a
 * {@link RecoveryRefusal} — see {@link recordFailure} and {@link UNEXPECTED_FAILURE_REASON} for why an
 * arbitrary exception's message does not. `RecoveryRefusal` is exported, and this function always
 * rethrows `perform`'s original error unchanged (see the `@throws` below) — so a caller of
 * `resetPassword`/`clearTwoFactor`/`unlockAccount` can `instanceof` it themselves to tell an
 * actionable refusal apart from an unexpected failure, exactly as this function does internally.
 *
 * @param prisma the client to read and write through
 * @param action which {@link RECOVERY_AUDIT_ACTIONS} this is
 * @param email the address naming the account
 * @param perform the change itself, given the resolved account id and the normalised address
 * @returns whatever `perform` returns
 * @throws {@link RecoveryRefusal} naming the address when it matches nothing; whatever `perform`
 *   throws otherwise; or, only when the `FAILURE` row itself cannot be written, a combined error
 *   carrying `perform`'s own failure as its `cause`
 */
async function recoverAccount<T>(
	prisma: PrismaClient,
	action: string,
	email: string,
	perform: (userId: string, normalizedEmail: string) => Promise<T>,
): Promise<T> {
	const normalized = normalizeEmail(email);
	const user = await prisma.user.findFirst({ where: { email: normalized }, select: { id: true } });

	if (!user) {
		// A RecoveryRefusal, not a plain Error: an address matching nothing is exactly the "one kind of
		// failure it expects" the module comment promises every export throws this for. The row's
		// `reason` is this refusal's own message rather than a second, separately maintained "no
		// account" literal — one text instead of two that could drift apart, and nothing new to leak:
		// the address it names is already sitting in `target.label` on the same row.
		const refusal = new RecoveryRefusal(`No account found for '${normalized}'.`);
		await appendAuditEvent(prisma, {
			action,
			outcome: "FAILURE",
			actor: CLI_RECOVERY_ACTOR,
			target: { kind: "user", label: normalized },
			detail: { reason: refusal.message },
			provenance: NO_PROVENANCE,
		} satisfies AuditEventInput);
		throw refusal;
	}

	let result: T;
	try {
		result = await perform(user.id, normalized);
	} catch (error) {
		await recordFailure(prisma, action, user.id, normalized, error);
		throw error;
	}

	await appendAuditEvent(prisma, {
		action,
		outcome: "SUCCESS",
		actor: CLI_RECOVERY_ACTOR,
		target: { kind: "user", id: user.id, label: normalized },
		provenance: NO_PROVENANCE,
	} satisfies AuditEventInput);
	return result;
}

/**
 * How many random bytes back a minted password, base64url-encoded.
 *
 * 128 bytes encodes to 171 base64url characters — well past `auth.minimumPasswordLength`'s declared
 * ceiling of 128 (`lib/settings/settings-service.ts`), so this mints a password whose length alone
 * clears whatever that setting is configured to, and well under `MAXIMUM_PASSWORD_LENGTH` (1024).
 */
const MINTED_PASSWORD_BYTES = 128;

/**
 * Mints a password nobody chose.
 *
 * Deliberately not an argument. A password passed on a command line lands in `~/.bash_history` and
 * in the process table, where it outlives the emergency it was typed for. This is generated, printed
 * once by the caller, carried to the login form, and replaced — `mustChangePassword` is set in the
 * same transaction, so the account cannot reach the panel until it has been.
 *
 * Long enough that its length alone satisfies any `auth.minimumPasswordLength` the install can be
 * configured with, so a recovery cannot fail on a policy the operator cannot currently reach to read.
 *
 * @returns the password, in plaintext, exactly once
 */
function mintPassword(): string {
	// node:crypto's randomBytes, not Math.random: this is credential material, not a display id.
	return randomBytes(MINTED_PASSWORD_BYTES).toString("base64url");
}

/**
 * Resets an account's password to one nobody chose, ends every session it holds, and forces a change
 * at next sign-in.
 *
 * Re-expresses `account-security.ts`'s `setAccountPassword` and `requirePasswordChange` together,
 * against a passed-in client rather than the bound singleton, and against the CLI's own audit rows
 * rather than `logger.info`. Kept identical in the parts that matter: the credential row is found by
 * `{ userId, issuer: CREDENTIAL_ISSUER }` and its count checked, exactly as `setAccountPassword`
 * does, so an account with no credential is reported rather than silently left with the password it
 * had; sessions are deleted in the same transaction as the password write, exactly as
 * `setAccountPassword` does, so a printed password cannot be typed in behind a session that is still
 * live on someone else's screen. Unlike `setAccountPassword`, the new password is never checked
 * against `passwordSchema` or recorded through `recordPasswordChange` — recovery mints its own value
 * deliberately outside the reuse history an operator's own choices are held to, and its length alone
 * already clears any configured minimum (see {@link mintPassword}). One consequence of skipping
 * `recordPasswordChange` is worth naming: `auth.passwordExpiryDays`' clock is keyed off that history,
 * so a recovery reset does not restart it the way an ordinary password change would.
 * `mustChangePassword` still blocks the account from reaching anything else in the meantime, so this
 * is a gap only until the very next sign-in — but it is a real one, not covered by anything else here.
 *
 * The row this writes lands after the transaction below commits, not inside it — see the module
 * comment's note on that window. Between the two, the credential is already replaced and the minted
 * password already works, but no row says so yet.
 *
 * @param prisma the client to write through
 * @param email the account's address
 * @returns the minted password, in plaintext, exactly once — the caller must print it and discard it
 * @throws {@link RecoveryRefusal} when the address matches no account, or the account has no
 *   password credential
 */
export async function resetPassword(prisma: PrismaClient, email: string): Promise<string> {
	return recoverAccount(prisma, RECOVERY_AUDIT_ACTIONS.RESET_PASSWORD, email, async (userId, normalizedEmail) => {
		const minted = mintPassword();
		const passwordHash = await hashPassword(minted);

		await prisma.$transaction(async (tx) => {
			const { count } = await tx.account.updateMany({
				where: { userId, issuer: CREDENTIAL_ISSUER },
				data: { password: passwordHash, updatedAt: new Date() },
			});
			if (count === 0) {
				throw new RecoveryRefusal(`Account '${normalizedEmail}' has no password credential to reset.`);
			}
			await tx.user.update({ where: { id: userId }, data: { mustChangePassword: true } });
			await tx.session.deleteMany({ where: { userId } });
		});

		return minted;
	});
}

/**
 * Clears an account's two-factor enrolment, so it can sign in without an authenticator it has lost.
 *
 * Re-expresses `account-security.ts`'s `clearTwoFactor(userId)` against a passed-in client. Kept
 * identical: the same two writes, `twoFactor.deleteMany` and `user.update({ twoFactorEnabled: false
 * })`, in the same one transaction, so `twoFactorEnabled` and the secret rows it depends on can never
 * be observed apart — a flag left set with no secret behind it is a challenge the account has nothing
 * to answer, which is a lockout rather than a reset.
 *
 * @param prisma the client to write through
 * @param email the account's address
 * @throws {@link RecoveryRefusal} when the address matches no account
 */
export async function clearTwoFactor(prisma: PrismaClient, email: string): Promise<void> {
	await recoverAccount(prisma, RECOVERY_AUDIT_ACTIONS.CLEAR_TWO_FACTOR, email, async (userId) => {
		await prisma.$transaction([
			prisma.twoFactor.deleteMany({ where: { userId } }),
			prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } }),
		]);
	});
}

/**
 * Clears an account's lockout before it would have expired on its own.
 *
 * Re-expresses `lockout.ts`'s `clearFailedSignIns(userId)` against a passed-in client. Kept
 * identical: the same two columns, `failedSignInCount` reset to 0 and `lockedUntil` cleared to null,
 * in the one update — leaving either behind would either strand the account with a stale lock or let
 * one more failure lock it again on a count that was never actually reset.
 *
 * **This is the password lockout, and only that one.** An enrolled account carries a second lock that
 * better-auth's two-factor plugin keeps on its own row — `TwoFactor.lockedUntil` and
 * `failedVerificationCount`, ten wrong codes for fifteen minutes, governed by no setting on this
 * install — and neither column is touched here. An administrator locked out by wrong *codes* is not
 * helped by this command at all; the only thing in this module that reaches them is
 * {@link clearTwoFactor}, which ends the lock by destroying the enrolment behind it. Widening
 * `--unlock` to clear both is a design decision, not a repair, and has not been made.
 *
 * @param prisma the client to write through
 * @param email the account's address
 * @throws {@link RecoveryRefusal} when the address matches no account
 */
export async function unlockAccount(prisma: PrismaClient, email: string): Promise<void> {
	await recoverAccount(prisma, RECOVERY_AUDIT_ACTIONS.UNLOCK, email, async (userId) => {
		await prisma.user.update({ where: { id: userId }, data: { lockedUntil: null, failedSignInCount: 0 } });
	});
}

/**
 * The one setting {@link clearAllowlist} writes.
 *
 * A literal, not `SettingKey`: that type is declared in `settings-service.ts`, which opens with
 * `import "server-only"` — the same problem `CLI_ACTOR` and `CREDENTIAL_ISSUER` have, above, this
 * time for a type rather than a value.
 */
const IP_ALLOWLIST_SETTING_KEY = "auth.ipAllowlist";

/**
 * Empties the address allowlist, because a wrong entry locks out everyone who holds a password,
 * including whoever wrote it.
 *
 * Re-expresses `settings-service.ts`'s `setSetting` storage format against a passed-in client, rather
 * than calling it: that module opens with `import "server-only"` and calls `applyPushedSettings()`
 * on every write, which pushes settings like the log level into synchronous global state — machinery
 * this script has no reason to run and every reason not to import. What is kept identical is the
 * shape on disk: `JSON.stringify` the value, then `upsert` it under the setting's key, exactly as
 * `setSetting` does, so a value this writes reads back through `stringSetting`/`listSettings` exactly
 * as one `setSetting` wrote would. The empty string is `auth.ipAllowlist`'s own built-in meaning of
 * "no restriction" (see its `SETTINGS` entry), so writing it is exactly what "clear" means for this
 * setting; no other validation applies to it.
 *
 * **This is the one export that does not share {@link recoverAccount}'s guarantee.** There is no
 * account to resolve or refuse against, so it does not go through that helper: the row it writes
 * carries no `target`, and the `upsert` above is not wrapped in a `try` the way `perform` callbacks
 * effectively are — an `upsert` failure here throws bare, with no `FAILURE` row behind it. That is
 * still defensible on its own terms, unlike a silent version of the same gap elsewhere in this file
 * would be: nothing changed, so there is nothing a row would be correcting the record about, and a
 * setting is not an account whose compromise this record exists to help investigate.
 *
 * @param prisma the client to write through
 */
export async function clearAllowlist(prisma: PrismaClient): Promise<void> {
	const stored = JSON.stringify("");
	await prisma.setting.upsert({
		where: { key: IP_ALLOWLIST_SETTING_KEY },
		update: { value: stored },
		create: { key: IP_ALLOWLIST_SETTING_KEY, value: stored },
	});

	await appendAuditEvent(prisma, {
		action: RECOVERY_AUDIT_ACTIONS.CLEAR_ALLOWLIST,
		outcome: "SUCCESS",
		actor: CLI_RECOVERY_ACTOR,
		provenance: NO_PROVENANCE,
	} satisfies AuditEventInput);
}
