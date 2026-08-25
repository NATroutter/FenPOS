import "server-only";
import { GENESIS_HASH, hashEvent } from "@/lib/audit/chain";
import { NO_PROVENANCE, type RequestProvenance } from "@/lib/audit/provenance";
import { prisma } from "@/lib/db";
import { isUniqueViolationOn } from "@/lib/db-errors";
import type { AuditOutcome } from "@/lib/domain/audit";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/redact";

/**
 * Writing the audit record.
 *
 * This is the only writer. There is no update path and no delete path, here or anywhere in the
 * application — the sole deletion that will ever exist is the retention sweep arriving in phase 5,
 * which runs oldest-first and re-anchors the chain behind it.
 *
 * **It never throws.** A line lost is a nuisance; an action refused because its audit row would not
 * store is a fault; and an action that happened and then threw on the way out is the worst of the
 * three, because the system did the thing and told the caller it did not. `recordServerLog` states
 * the same rule for the same reason. Every failure is reported through `logger.error` and swallowed.
 *
 * **Two writers cannot fork the chain.** `AuditEvent.prevHash` is unique, so the second insert
 * claiming a given predecessor is refused by the database rather than accepted into a branch. This
 * catches that refusal and retries against whatever row won.
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
 * How many times a losing writer re-reads the tail and tries again.
 *
 * Bounded rather than unbounded because this runs on the way out of a real request: a writer that
 * kept retrying under sustained contention would hold the request open indefinitely, which is the
 * failure this module's whole "never throws" posture exists to avoid. Five is generous — losing
 * five in a row means five other events committed while this one was being written.
 */
const MAX_CHAIN_ATTEMPTS = 5;

/** Where `detail` is truncated. Bounds the row against a caller passing something enormous. */
const MAX_DETAIL_CHARS = 8_000;

/** The unique constraint a losing writer hits, in database naming. */
const CHAIN_CONSTRAINT_COLUMNS = ["prev_hash"] as const;

/**
 * Records one event.
 *
 * @param input the event
 */
export async function recordAudit(input: AuditEventInput): Promise<void> {
	try {
		const provenance = input.provenance ?? NO_PROVENANCE;
		const fields = {
			// Captured here and written explicitly, never left to the column's default: the hash
			// covers this value, so the timestamp hashed and the timestamp stored must be one value
			// rather than two readings of the clock.
			at: new Date(),
			actorKind: input.actor.kind,
			actorUserId: input.actor.kind === "USER" ? input.actor.userId : null,
			actorName: input.actor.kind === "USER" ? input.actor.name : null,
			actorEmail: input.actor.kind === "USER" ? input.actor.email : null,
			apiKeyId: input.actor.kind === "API_KEY" ? input.actor.apiKeyId : null,
			apiKeyName: input.actor.kind === "API_KEY" ? input.actor.apiKeyName : null,
			action: input.action,
			targetKind: input.target?.kind ?? null,
			targetId: input.target?.id ?? null,
			targetLabel: input.target?.label ?? null,
			outcome: input.outcome,
			detail: encodeDetail(input.detail),
			ipAddress: provenance.ipAddress,
			userAgent: provenance.userAgent,
			sessionId: provenance.sessionId,
		};

		for (let attempt = 1; attempt <= MAX_CHAIN_ATTEMPTS; attempt++) {
			// Re-read on every attempt: losing the constraint means somebody else's row is now the
			// tail, and chaining onto the stale one would lose the same race again.
			const prevHash = await tailHash();

			try {
				await prisma.auditEvent.create({ data: { ...fields, prevHash, hash: hashEvent(fields, prevHash) } });
				return;
			} catch (error) {
				if (!isUniqueViolationOn(error, CHAIN_CONSTRAINT_COLUMNS) || attempt === MAX_CHAIN_ATTEMPTS) {
					throw error;
				}
			}
		}
	} catch (error) {
		// Swallowed on purpose — see the module comment. Logged with the action so an event missing
		// from the record is diagnosable rather than merely absent.
		logger.error("Could not record an audit event", error, { action: input.action, outcome: input.outcome });
	}
}

/**
 * Redacts and encodes `detail`.
 *
 * Redaction runs before encoding rather than on the finished string, so a secret is removed as a
 * value rather than matched as text — the same rule `logger.ts` follows, through the same module,
 * which is what stops the two from disagreeing about what is unsafe to record.
 *
 * @param detail the caller's fields, or undefined
 * @returns the JSON text to store, or null when there is nothing to store
 */
function encodeDetail(detail: Record<string, unknown> | undefined): string | null {
	if (detail === undefined) {
		return null;
	}
	return JSON.stringify(redact(detail)).slice(0, MAX_DETAIL_CHARS);
}

/**
 * What the next row must name as its predecessor.
 *
 * Three-deep, and the middle step is the one that matters. After a retention sweep that removed every
 * row, the table is empty but `AuditAnchor` holds the last swept event — and `verifyAuditChain` starts
 * its walk from that anchor and requires the oldest surviving row's `prevHash` to equal it
 * (`verify.ts`). Falling straight through to genesis there would make an untouched chain report
 * `anchor-mismatch`: the record accusing itself of tampering, with no tampering to find.
 *
 * Genesis is reached only on an install that has never recorded and never swept.
 *
 * @returns the tail row's hash, else the anchor's, else {@link GENESIS_HASH}
 */
async function tailHash(): Promise<string> {
	const tail = await prisma.auditEvent.findFirst({ orderBy: { seq: "desc" }, select: { hash: true } });
	if (tail) {
		return tail.hash;
	}
	const anchor = await prisma.auditAnchor.findUnique({ where: { id: 1 }, select: { hash: true } });
	return anchor?.hash ?? GENESIS_HASH;
}
