import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { isUniqueViolationOn } from "@/lib/db-errors";
import { ApiError } from "@/lib/errors";

/**
 * Making a retried submit safe.
 *
 * A POS terminal that times out on a submit is in the one position this system cannot otherwise
 * help with: retry and risk printing the receipt twice, or do not and risk not printing it at all.
 * An `Idempotency-Key` resolves it — the second request either replays the first's answer or is
 * refused for disagreeing with it, and in neither case does a second receipt come out.
 *
 * The job row is the record. There is no separate table with its own lifetime, so a key can never
 * outlive the job it describes. **What that does not mean is that a key is ever freed.** Nothing in
 * this server sweeps the `Job` table today, so a key recorded here is retained for as long as the
 * row is — which, in practice, is forever. Integrators are told as much on the docs page and pointed
 * at a for-all-time-unique key (a UUID) rather than something like an order number that could recur.
 */

/**
 * The original job, as the replayed response describes it.
 *
 * `status` is always `"QUEUED"` — what the original `202` said, not what the row has become
 * since. A replay answers "what did I tell you before", not "what is true now"; a caller wanting
 * the latter has `GET /api/v1/jobs/{id}`.
 */
export interface IdempotentReplay {
	jobId: string;
	status: string;
	deviceName: string;
	lines: number | null;
}

/**
 * Fingerprints a request body.
 *
 * Over the raw text rather than the parsed object, deliberately. Two bodies that differ only in
 * whitespace are two different requests as far as this is concerned, which errs towards refusing a
 * retry that might not be one — the safe direction, since the caller is then told to look rather
 * than handed a receipt they did not ask for.
 *
 * @param raw the request body exactly as it arrived
 * @returns a hex SHA-256 digest
 */
export function bodyHash(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Decides what a presented idempotency key means for this request.
 *
 * The device is checked as well as the body, deliberately, and checked first. A key granted more
 * than one printer can be reused unmodified against a second one with the exact same body — a
 * kitchen ticket and a bar ticket both reading "order 1041" — and a hash taken over the body alone
 * cannot see that, because the body genuinely is identical. Reusing one key for two different
 * requests is a caller error; refusing it is what keeps the second printer from silently never
 * seeing the job at all.
 *
 * @param apiKeyId the authenticated key, which scopes the idempotency key
 * @param key the caller's `Idempotency-Key` header
 * @param hash the current body's {@link bodyHash}
 * @param deviceId the device this request is addressed to
 * @returns the original job to replay, or null when this key has not been used before
 * @throws ApiError `idempotency_conflict` when the key was used for a different device, or with a
 *   different body
 */
export async function findReplay(
	apiKeyId: string,
	key: string,
	hash: string,
	deviceId: string,
): Promise<IdempotentReplay | null> {
	const existing = await prisma.job.findFirst({
		where: { apiKeyId, idempotencyKey: key },
		select: {
			id: true,
			deviceId: true,
			lines: true,
			idempotencyHash: true,
			device: { select: { name: true } },
		},
	});

	if (!existing) {
		return null;
	}

	if (existing.deviceId !== deviceId) {
		throw new ApiError(
			"idempotency_conflict",
			`Idempotency-Key '${key}' was already used to print to a different printer. Use a new key for a different receipt.`,
			{ jobId: existing.id },
		);
	}

	if (existing.idempotencyHash !== hash) {
		throw new ApiError(
			"idempotency_conflict",
			`Idempotency-Key '${key}' was already used with a different request body. Use a new key for a different receipt.`,
			{ jobId: existing.id },
		);
	}

	return {
		jobId: existing.id,
		// Hardcoded rather than read from the row: see the note on IdempotentReplay.
		status: "QUEUED",
		deviceName: existing.device.name,
		lines: existing.lines,
	};
}

/**
 * The columns SQLite names when `(api_key_id, idempotency_key)` is what refused an insert.
 *
 * Mapped column names, not the Prisma field names — the driver adapter reports the constraint the
 * way the database itself describes it, and `@map` means those are not spelled the same.
 */
const IDEMPOTENCY_CONSTRAINT_COLUMNS = ["api_key_id", "idempotency_key"];

/**
 * Whether a job insert lost a race against another submit carrying the same idempotency key.
 *
 * Two requests presenting the same `Idempotency-Key` can arrive together — a double-tap, or a
 * client retrying the instant it times out. Both see no existing row and both insert; the loser
 * hits the unique constraint this module relies on to make a *sequential* retry safe. Left
 * unhandled, that surfaces as an opaque `internal_error`, in precisely the case this feature
 * exists to make safe.
 *
 * Narrowness is enforced by {@link isUniqueViolationOn}, which documents why.
 *
 * @param error the value `prisma.job.create` threw
 * @returns true only when this is Prisma reporting exactly the `(apiKeyId, idempotencyKey)` unique
 *   constraint, and not some other insert failure
 */
export function isIdempotencyKeyRace(error: unknown): boolean {
	return isUniqueViolationOn(error, IDEMPOTENCY_CONSTRAINT_COLUMNS);
}
