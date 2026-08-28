import "server-only";
import { appendAuditEvent } from "@/lib/audit/append";
import type { RequestProvenance } from "@/lib/audit/provenance";
import { auditDb } from "@/lib/db";
import type { AuditOutcome } from "@/lib/domain/audit";
import { logger } from "@/lib/logger";

/**
 * Writing the audit record.
 *
 * This is the only writer. There is no update path and no delete path here — the sole deletion of a
 * live row that exists anywhere is `lib/audit/retention.ts`, which runs oldest-first and re-anchors the
 * chain behind it, and which nothing on this path triggers: retention is `lib/maintenance/pass.ts`'s
 * hourly pass, because a sweep now archives before it deletes and that does not belong behind a
 * request. Past the live window the record is a set of `audit-*.db.gz` files rather than rows, and one
 * of those can be deleted by hand on the panel's Archives tab under `audit:archive-delete` — a second
 * way history leaves the install, reaching none of the rows this module writes.
 *
 * **It never throws.** A line lost is a nuisance; an action refused because its audit row would not
 * store is a fault; and an action that happened and then threw on the way out is the worst of the
 * three, because the system did the thing and told the caller it did not. `recordServerLog` states
 * the same rule for the same reason. Every failure is reported through `logger.error` and swallowed.
 *
 * **Two writers cannot fork the chain.** `AuditEvent.prevHash` is unique, so the second insert
 * claiming a given predecessor is refused by the database rather than accepted into a branch. This
 * catches that refusal and retries against whatever row won.
 *
 * **It writes to `audit.db`, through `auditDb`.** The record has its own file so its retention is
 * decided by its own settings and no other table's growth can shorten it, and the write itself
 * touches nothing but `audit.db` — not even to decide whether to sweep, which nothing here does any
 * more.
 */

/** Who an event is attributed to. A discriminated union, so a `USER` row cannot carry a key's name. */
export type AuditActor =
	| { kind: "USER"; userId: string | null; name: string | null; email: string | null }
	| { kind: "API_KEY"; apiKeyId: string; apiKeyName: string }
	| { kind: "SYSTEM" }
	| { kind: "SETUP" }
	| { kind: "CLI" };

/**
 * Attributes an event to a signed-in user.
 *
 * @param user the acting user; only the three recorded fields are required, so a caller holding a
 *   full `PanelUser` can pass it directly
 * @returns the actor
 */
export function userActor(user: { id: string; name: string; email: string }): AuditActor {
	return { kind: "USER", userId: user.id, name: user.name, email: user.email };
}

/**
 * Attributes an event to whoever presented an email address, without claiming an account exists.
 *
 * For a refused sign-in. The address is recorded because it is the single most useful field in the
 * row — "somebody tried this address forty times" is the question the log is being read to answer —
 * while `actorUserId` stays null, because resolving it would mean disclosing whether the address
 * matches an account, which is precisely what the sign-in path refuses to disclose.
 *
 * @param email the address as submitted, already normalised by the caller
 * @returns the actor
 */
export function unknownUserActor(email: string): AuditActor {
	return { kind: "USER", userId: null, name: null, email };
}

/**
 * Attributes an event to an API key.
 *
 * The key's name is denormalised here for the same reason the actor's is: a key that is deleted
 * afterwards must not take its trail with it.
 *
 * @param key the key that made the request
 * @returns the actor
 */
export function apiKeyActor(key: { id: string; name: string }): AuditActor {
	return { kind: "API_KEY", apiKeyId: key.id, apiKeyName: key.name };
}

/** The server acting on its own: retention sweeps, startup tasks. */
export const SYSTEM_ACTOR: AuditActor = { kind: "SYSTEM" };

/** First-run setup, which happens before any account exists and so cannot name a person. */
export const SETUP_ACTOR: AuditActor = { kind: "SETUP" };

/** Someone with filesystem access, acting outside the panel entirely. */
export const CLI_ACTOR: AuditActor = { kind: "CLI" };

/** One event, as a caller describes it. */
export interface AuditEventInput {
	/** Registry id, e.g. `devices:delete`. */
	action: string;
	outcome: AuditOutcome;
	actor: AuditActor;
	/** What was acted on. Denormalised, so it survives the thing's deletion. */
	target?: { kind: string; id?: string | null; label?: string | null };
	/**
	 * Parameters, before and after, error text. Redacted and JSON-encoded before storage.
	 *
	 * Pass **named fields**, never a raw `FormData` dump or a whole request body: redaction matches
	 * exact key names, so a field nobody listed goes in as it stands.
	 */
	detail?: Record<string, unknown>;
	/** Where the request came from. Omit outside a request. */
	provenance?: RequestProvenance;
}

/**
 * Appends one event to the chain.
 *
 * The half of {@link recordAudit} that writes, and — now that recording an event triggers nothing
 * else — the whole of it. Both names survive because both are already spoken: `recordAudit` is what
 * every caller in `app/` says and what `test/lib/auth/registry-coverage.test.ts` reads the registry
 * against, while this is what the callers outside a request say, `lib/maintenance/pass.ts`'s own
 * `audit:sweep` row among them.
 *
 * The write itself — the field list, the hashing, the `prevHash` retry — lives in
 * `lib/audit/append.ts`, so the same chaining logic runs whether the caller is a request or
 * `pnpm auth:recover`. What stays here is the swallow: `append.ts` cannot import `lib/logger.ts`,
 * which itself opens with `import "server-only"` and would break the very script `append.ts` exists
 * to serve, so the catch that makes this "never throw" lives on this side of the call instead.
 *
 * @param input the event
 */
export async function appendEvent(input: AuditEventInput): Promise<void> {
	try {
		await appendAuditEvent(auditDb, input);
	} catch (error) {
		// Swallowed on purpose — see the module comment. Logged with the action so an event missing
		// from the record is diagnosable rather than merely absent.
		logger.error("Could not record an audit event", error, { action: input.action, outcome: input.outcome });
	}
}

/**
 * Records one event.
 *
 * The entry point every caller inside a request uses, and the name the panel action registry is
 * written in terms of. It no longer does anything {@link appendEvent} does not: retention used to be
 * counted here, one sweep every *n*th recorded event, and now runs on `lib/maintenance/pass.ts`'s
 * timer instead — so an install that has stopped writing still sweeps, and an install that is writing
 * hard no longer pays for a rotation on the way out of a request.
 *
 * @param input the event
 */
export async function recordAudit(input: AuditEventInput): Promise<void> {
	await appendEvent(input);
}
