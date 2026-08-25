/**
 * Field names whose values are never written, and the redactor that applies the rule.
 *
 * Lives here rather than inside `logger.ts` because two consumers need the same answer: the process
 * logger writing to stdout, and the audit writer writing `AuditEvent.detail` to a table that has no
 * edit path. If those two lists ever disagreed, the disagreement would be invisible until the day a
 * token turned up in a row nobody can delete.
 *
 * A redaction list is a backstop rather than a policy: callers are expected not to pass secrets at
 * all. It exists because the cost of one accidental token in a record is far higher than the cost
 * of checking a handful of keys on every line.
 */

/** What a redacted value is replaced with. Named so callers can assert on it rather than on a literal. */
export const REDACTION_MARKER = "[redacted]";

/** What a value beyond the recursion bound is replaced with. */
export const TRUNCATION_MARKER = "[truncated]";

/**
 * The normalised key names whose values are dropped.
 *
 * **Matching is exact on the normalised key, not substring**, and that is deliberate. Substring
 * matching would catch `newPassword` for free, and would also blank `passwordPolicyMinimum` and
 * `passwordChangedAt` — turning the fields that make an audit row readable into markers. So each
 * shape the codebase actually produces is listed instead. Add a name here when you add a field that
 * carries a secret; do not reach for a looser rule.
 */
export const REDACTED_KEYS: readonly string[] = [
	"token",
	"tokenhash",
	"password",
	"passwordhash",
	"newpassword",
	"currentpassword",
	"confirmpassword",
	"apikey",
	"keyhash",
	"secret",
	"setupkey",
	"authorization",
	"cookie",
	"code",
	"codehash",
	"codeplain",
	"backupcodes",
	"recoverycode",
	"recoverycodes",
	"totpsecret",
	"sessiontoken",
];

/** How deep the redactor descends before giving up. */
const MAX_DEPTH = 6;

/**
 * Replaces the values of sensitive keys with a marker, recursively.
 *
 * Matching is case-insensitive and ignores separators, so `api_key`, `apiKey`, and `APIKEY` are all
 * caught. Depth is bounded because a cyclic or deeply nested object passed by mistake must not turn
 * a log call — or an audit write — into a stack overflow.
 *
 * @param value the value to sanitise
 * @param depth current recursion depth, used to enforce the bound
 * @returns a structurally similar value with sensitive fields replaced
 */
export function redact(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) {
		return TRUNCATION_MARKER;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => redact(entry, depth + 1));
	}
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(source)) {
			const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, "");
			output[key] = REDACTED_KEYS.includes(normalised) ? REDACTION_MARKER : redact(entry, depth + 1);
		}
		return output;
	}
	return value;
}
