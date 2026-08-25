/**
 * Reading what the database actually refused.
 *
 * Three modules need to tell one specific unique constraint from every other insert failure — the
 * idempotency key, the webhook delivery, and the audit chain's `prev_hash`. Each of them handles
 * its constraint by carrying on (replay the earlier job, drop the duplicate delivery, retry against
 * the row that won) and must not treat an unrelated failure the same way.
 *
 * They shared no code until there were three of them, on the stated reasoning that an idempotency
 * helper and a webhook helper have nothing to do with each other. That reasoning was about business
 * meaning, and what is actually duplicated here is not business meaning: it is a four-level probe
 * into `@prisma/adapter-better-sqlite3`'s internal error shape. Three copies of that fail together
 * on a driver upgrade and get fixed one at a time, and the copy that gets missed does not raise an
 * error — it silently stops matching, and its caller starts treating a handled race as a fault.
 */

/**
 * Whether an error is this driver reporting a unique violation on exactly the named columns.
 *
 * Deliberately narrow in both directions: the constraint must be a unique violation (`P2002`), and
 * its column set must equal the one asked about rather than merely contain it. A table can grow a
 * second unique constraint later, and a caller that matched loosely would mistake that unrelated
 * failure for the race it knows how to recover from.
 *
 * @param error the value a Prisma write threw
 * @param columns the constraint's columns, in database naming, in any order
 * @returns true only for a `P2002` naming exactly those columns
 */
export function isUniqueViolationOn(error: unknown, columns: readonly string[]): boolean {
	if (typeof error !== "object" || error === null || (error as { code?: unknown }).code !== "P2002") {
		return false;
	}

	const fields = constraintFields((error as { meta?: unknown }).meta);
	if (fields === null || fields.length !== columns.length) {
		return false;
	}

	const reported = new Set(fields);
	return columns.every((column) => reported.has(column));
}

/**
 * Reads the column names a `P2002`'s `meta` names, if it names any.
 *
 * The driver adapter used here (better-sqlite3, see `lib/db.ts`) reports them at
 * `meta.driverAdapterError.cause.constraint.fields` rather than the flatter `meta.target` some
 * other Prisma connectors use — confirmed against this project's actual client rather than assumed,
 * since guessing wrong would make every caller silently match nothing.
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
