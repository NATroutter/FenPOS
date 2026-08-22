import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";

/**
 * Making a retried submit safe.
 *
 * A POS terminal that times out on a submit is in the one position this system cannot otherwise
 * help with: retry and risk printing the receipt twice, or do not and risk not printing it at all.
 * An `Idempotency-Key` resolves it — the second request either replays the first's answer or is
 * refused for disagreeing with it, and in neither case does a second receipt come out.
 *
 * The job row is the record. There is no separate table with its own lifetime, so nothing can
 * outlive the job it describes and answer a retry about a job that is no longer here.
 */

/** The original job, as the replayed response describes it. */
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
 * @param apiKeyId the authenticated key, which scopes the idempotency key
 * @param key the caller's `Idempotency-Key` header
 * @param hash the current body's {@link bodyHash}
 * @returns the original job to replay, or null when this key has not been used before
 * @throws ApiError `idempotency_conflict` when the key was used with a different body
 */
export async function findReplay(apiKeyId: string, key: string, hash: string): Promise<IdempotentReplay | null> {
	const existing = await prisma.job.findFirst({
		where: { apiKeyId, idempotencyKey: key },
		select: {
			id: true,
			status: true,
			lines: true,
			idempotencyHash: true,
			device: { select: { name: true } },
		},
	});

	if (!existing) {
		return null;
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
		status: existing.status,
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
 * Matched on the error code and the constraint's own columns, deliberately narrow: the `Job` table
 * could grow another unique constraint later, and a broad `catch` on "some insert failed" would
 * mistake that unrelated failure for a replay and answer it with someone else's job.
 *
 * @param error the value `prisma.job.create` threw
 * @returns true only when this is Prisma reporting exactly the `(apiKeyId, idempotencyKey)` unique
 *   constraint, and not some other insert failure
 */
export function isIdempotencyKeyRace(error: unknown): boolean {
	if (typeof error !== "object" || error === null || (error as { code?: unknown }).code !== "P2002") {
		return false;
	}

	const meta = (error as { meta?: unknown }).meta;
	const fields = constraintFields(meta);
	if (fields === null || fields.length !== IDEMPOTENCY_CONSTRAINT_COLUMNS.length) {
		return false;
	}

	const columns = new Set(fields);
	return IDEMPOTENCY_CONSTRAINT_COLUMNS.every((column) => columns.has(column));
}

/**
 * Reads the column names a `P2002`'s `meta` names, if it names any.
 *
 * The driver adapter used here (better-sqlite3, see `lib/db.ts`) reports them at
 * `meta.driverAdapterError.cause.constraint.fields` rather than the flatter `meta.target` some
 * other Prisma connectors use — confirmed against this project's actual client rather than
 * assumed, since guessing wrong here would make {@link isIdempotencyKeyRace} silently match
 * nothing and every race would fall through as an unhandled fault again.
 *
 * @param meta the `meta` field of a caught `PrismaClientKnownRequestError`
 * @returns the column names, or null when the shape does not carry any
 */
function constraintFields(meta: unknown): string[] | null {
	if (typeof meta !== "object" || meta === null) {
		return null;
	}
	const driverAdapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
	if (typeof driverAdapterError !== "object" || driverAdapterError === null) {
		return null;
	}
	const cause = (driverAdapterError as { cause?: unknown }).cause;
	if (typeof cause !== "object" || cause === null) {
		return null;
	}
	const constraint = (cause as { constraint?: unknown }).constraint;
	if (typeof constraint !== "object" || constraint === null) {
		return null;
	}
	const fields = (constraint as { fields?: unknown }).fields;
	return Array.isArray(fields) && fields.every((field) => typeof field === "string") ? (fields as string[]) : null;
}
