import type { PrismaClient } from "@/generated/prisma/client";
import type { AuditEventInput } from "@/lib/audit/audit-log";
import { GENESIS_HASH, hashEvent } from "@/lib/audit/chain";
import type { RequestProvenance } from "@/lib/audit/provenance";
import { isUniqueViolationOn } from "@/lib/db-errors";
import { redact } from "@/lib/redact";

/**
 * How a row joins the hash chain, with the client passed in.
 *
 * Split out of `audit-log.ts` so it can run outside Next. That module opens with `import
 * "server-only"` and binds the `prisma` singleton, which is right for the panel and fatal for
 * `pnpm auth:recover` — a recovery tool that could not write an audit row would be the most useful
 * thing on the box to somebody who should not be there.
 *
 * There is exactly one implementation of the append, and this is it: `audit-log.ts` calls straight
 * into here with the singleton. A second copy in the script would be a second opinion about a
 * stored contract, which is how the two drift and how a chain stops verifying.
 *
 * **No sweep is triggered here.** `recordAudit` still owns that, because a retention sweep is a
 * consequence of the panel's write volume and not something a recovery command should set off.
 *
 * **This throws on failure; it does not swallow.** `audit-log.ts`'s module comment promises that the
 * panel's writer never throws, and that promise still holds there — `appendEvent` catches what this
 * throws and reports it through `logger.error`, exactly as it always has. That catch could not move
 * down here: `lib/logger.ts` also opens with `import "server-only"`, and importing it would break
 * this module for the one caller it exists to serve. A caller that wants the swallow gets it from
 * `audit-log.ts`; a caller that wants to know a write failed — the CLI included — gets a rejected
 * promise.
 *
 * @param prisma the client to write through
 * @param input the event to record
 */
export async function appendAuditEvent(prisma: PrismaClient, input: AuditEventInput): Promise<void> {
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
		const prevHash = await tailHash(prisma);

		try {
			await prisma.auditEvent.create({ data: { ...fields, prevHash, hash: hashEvent(fields, prevHash) } });
			return;
		} catch (error) {
			if (!isUniqueViolationOn(error, CHAIN_CONSTRAINT_COLUMNS) || attempt === MAX_CHAIN_ATTEMPTS) {
				throw error;
			}
		}
	}
}

/**
 * How many times a losing writer re-reads the tail and tries again.
 *
 * Bounded rather than unbounded because the panel's caller is usually a request on its way out: a
 * writer that kept retrying under sustained contention would hold that request open indefinitely.
 * Five is generous — losing five in a row means five other events committed while this one was
 * being written.
 */
const MAX_CHAIN_ATTEMPTS = 5;

/** Where `detail` is truncated. Bounds the row against a caller passing something enormous. */
const MAX_DETAIL_CHARS = 8_000;

/** The unique constraint a losing writer hits, in database naming. */
const CHAIN_CONSTRAINT_COLUMNS = ["prev_hash"] as const;

/**
 * What a caller outside any request — the CLI included — gets when it passes no `provenance`.
 *
 * Not imported from `lib/audit/provenance.ts`: that module also opens with `import "server-only"`,
 * which would throw the moment a script loaded this one. The value is the same one `NO_PROVENANCE`
 * names there, kept in sync by hand — the type import above still ties this literal to that module's
 * shape, so a field added to `RequestProvenance` fails to compile here until it is added below too.
 */
const NO_PROVENANCE: RequestProvenance = { ipAddress: null, userAgent: null, sessionId: null };

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
 * @param prisma the client to read through
 * @returns the tail row's hash, else the anchor's, else {@link GENESIS_HASH}
 */
async function tailHash(prisma: PrismaClient): Promise<string> {
	const tail = await prisma.auditEvent.findFirst({ orderBy: { seq: "desc" }, select: { hash: true } });
	if (tail) {
		return tail.hash;
	}
	const anchor = await prisma.auditAnchor.findUnique({ where: { id: 1 }, select: { hash: true } });
	return anchor?.hash ?? GENESIS_HASH;
}
