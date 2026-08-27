import "server-only";
import { appendAuditEvent } from "@/lib/audit/append";
import type { RequestProvenance } from "@/lib/audit/provenance";
import { sweepAuditNow } from "@/lib/audit/retention";
import { AUDIT_SWEEP_ACTION } from "@/lib/audit/system-actions";
import { auditDb } from "@/lib/db";
import type { AuditOutcome } from "@/lib/domain/audit";
import { logger } from "@/lib/logger";
import { globalAuditSettings } from "@/lib/settings/settings-service";

/**
 * Writing the audit record.
 *
 * This is the only writer. There is no update path and no delete path here — the sole deletion that
 * exists anywhere is `lib/audit/retention.ts`, which runs oldest-first and re-anchors the chain
 * behind it, and which this module triggers by write count.
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
 * decided by its own settings and no other table's growth can shorten it. The sweep's *bounds* are
 * still read from the application database — {@link maybeSweep} calls `globalAuditSettings()` — so
 * an unreadable `fenpos.db` leaves the record unswept and growing, which {@link maybeSweep} logs
 * and swallows. The write itself touches nothing but `audit.db`.
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
 * Appends one event to the chain, without triggering retention.
 *
 * The half of {@link recordAudit} that writes. Exported for exactly one caller: the retention sweep,
 * whose own row must not trigger another sweep — which is what going back through `recordAudit`
 * would do, once per sweep, forever. Nothing else should call this; a caller that skips retention is
 * a caller that lets the table grow past its bounds.
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
 * Records one event, and sweeps if enough have accumulated since the last sweep.
 *
 * The entry point every caller but the sweep itself uses. Retention is counted in writes rather than
 * scheduled on a timer, so a quiet install does no work at all and a busy one sweeps in proportion to
 * what it is producing — the same shape `lib/logs/ingest.ts` uses for `LogEntry`, and for the same
 * reason.
 *
 * The sweep is not awaited. It is bookkeeping behind an event that has already been written, and the
 * caller is usually a request on its way out; making a print wait for the deletion of two hundred
 * thousand rows would be paying for tidiness with latency. {@link maybeSweep} never throws.
 *
 * @param input the event
 */
export async function recordAudit(input: AuditEventInput): Promise<void> {
	await appendEvent(input);
	void maybeSweep();
}

/**
 * How many events this process has recorded, and how often it currently intends to sweep.
 *
 * Both reset by a restart, which is harmless: the counter decides when to *look*, and the sweep
 * itself decides what to do based on what is actually in the table.
 */
const globalForAudit = globalThis as unknown as {
	fenposAuditWrites: number | undefined;
	fenposAuditSweepEvery: number | undefined;
};

/**
 * `audit.sweepEvery`'s declared minimum, used until a real value has been read.
 *
 * The floor rather than the fallback, so the very first check of a process can only ever come
 * *sooner* than configured, never later.
 */
const MINIMUM_SWEEP_EVERY = 50;

/**
 * Sweeps every `audit.sweepEvery` recorded events.
 *
 * The interval is cached rather than read per event, and that is why this reads as awkwardly as it
 * does: it runs on the way out of every recorded action, so reading four settings to decide "not this
 * time" would put a database round trip behind every audit row in the system. The cached value is
 * refreshed each time a sweep is actually due, so a changed interval takes effect at the next sweep
 * rather than at the next restart. `lib/logs/ingest.ts` caches its own settings for the same reason,
 * one layer up.
 *
 * **Never throws**, for the reason the module comment gives: this runs behind an event that has
 * already been written, and a failed sweep is a table that is briefly larger than its bounds, while a
 * thrown one would surface as a failure of whatever action happened to be the five-hundredth.
 */
async function maybeSweep(): Promise<void> {
	try {
		const writes = (globalForAudit.fenposAuditWrites ?? 0) + 1;
		globalForAudit.fenposAuditWrites = writes;

		if (writes % (globalForAudit.fenposAuditSweepEvery ?? MINIMUM_SWEEP_EVERY) !== 0) {
			return;
		}

		const { retentionDays, maxRecords, sweepEvery } = await globalAuditSettings();
		globalForAudit.fenposAuditSweepEvery = sweepEvery;

		const outcome = await sweepAuditNow({ retentionDays, maxRecords });
		if (outcome === null) {
			return;
		}

		// Through `appendEvent`, not `recordAudit`: a sweep row that advanced the counter again would
		// sweep on every `sweepEvery`-th sweep, forever.
		await appendEvent({
			action: AUDIT_SWEEP_ACTION,
			outcome: "SUCCESS",
			actor: SYSTEM_ACTOR,
			detail: { removed: outcome.removed, anchoredAt: outcome.anchoredAt, retentionDays, maxRecords },
		});
	} catch (error) {
		logger.error("Could not sweep the audit record", error);
	}
}
