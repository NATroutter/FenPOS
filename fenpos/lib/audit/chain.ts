import { createHash } from "node:crypto";

/**
 * The hash chain that makes the audit record tamper-evident.
 *
 * Pure: no database, no clock, no configuration. That is what lets a golden vector pin its output,
 * and a pinned vector is the only thing standing between a well-meaning edit here and the silent
 * invalidation of every hash on every install.
 *
 * **The canonical form below is a stored contract.** Rows already written were hashed with this
 * exact field list, in this exact order, with this exact encoding. Adding a field, reordering two,
 * or changing the separator does not migrate old rows — it makes them read as tampered. If a future
 * phase genuinely needs a new covered field, that is a versioning decision (a marker stored per row,
 * and a verifier that switches on it), not an edit to the list.
 */

/**
 * What the first row's `prevHash` is.
 *
 * Sixty-four zeros: the same width as a SHA-256 digest, and a value no digest can be. It is stored
 * in the `prev_hash` column like any other predecessor, which means the unique constraint applies to
 * it too — so there can only ever be one genesis row.
 */
export const GENESIS_HASH = "0".repeat(64);

/** The fields the hash covers. Every one of them is a column on `AuditEvent`. */
export interface ChainedFields {
	at: Date;
	actorKind: string;
	actorUserId: string | null;
	actorName: string | null;
	actorEmail: string | null;
	apiKeyId: string | null;
	apiKeyName: string | null;
	action: string;
	targetKind: string | null;
	targetId: string | null;
	targetLabel: string | null;
	outcome: string;
	detail: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	sessionId: string | null;
}

/**
 * The order fields are fed to the digest.
 *
 * Declared as a list rather than relying on object key order, because object key order is a
 * property of how a value happened to be constructed and this needs to be a property of the module.
 * `seq` is deliberately absent: it is assigned by the database on insert, so it is not knowable at
 * the moment the hash is computed. Ordering is carried by the chain's links instead, which is
 * stronger — a row moved to a different `seq` still has to link to the row it claims to follow.
 */
const CANONICAL_FIELDS: readonly (keyof ChainedFields)[] = [
	"at",
	"actorKind",
	"actorUserId",
	"actorName",
	"actorEmail",
	"apiKeyId",
	"apiKeyName",
	"action",
	"targetKind",
	"targetId",
	"targetLabel",
	"outcome",
	"detail",
	"ipAddress",
	"userAgent",
	"sessionId",
];

/**
 * Renders one field's value in a form two runs will always agree on.
 *
 * @param value the field's value
 * @returns a JSON-encodable equivalent
 */
function serialise(value: Date | string | null | undefined): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	return value instanceof Date ? value.toISOString() : value;
}

/**
 * Renders the covered fields as one deterministic string.
 *
 * Each field is written as `name=<json>` and the lines are joined with a newline. Values go through
 * `JSON.stringify` rather than being interpolated, which is what stops a value from forging the
 * structure around it: a `detail` containing a newline and an `=` would otherwise be
 * indistinguishable from two separate fields, and an attacker who controls one field could then
 * make a row hash as though another field held something else.
 *
 * @param fields the covered fields
 * @returns the canonical rendering
 */
export function canonicalise(fields: ChainedFields): string {
	return CANONICAL_FIELDS.map((name) => `${name}=${JSON.stringify(serialise(fields[name]))}`).join("\n");
}

/**
 * Computes a row's hash from its own fields and its predecessor's.
 *
 * The predecessor comes first so that the digest is over `<prevHash>\n<canonical>` — a row's hash
 * therefore depends on the entire history behind it, which is what makes a change anywhere in the
 * chain detectable at the point it happened rather than only at the end.
 *
 * @param fields the covered fields
 * @param prevHash the previous row's hash, or {@link GENESIS_HASH} for the first row
 * @returns lowercase hex SHA-256
 */
export function hashEvent(fields: ChainedFields, prevHash: string): string {
	return createHash("sha256")
		.update(`${prevHash}\n${canonicalise(fields)}`, "utf8")
		.digest("hex");
}
