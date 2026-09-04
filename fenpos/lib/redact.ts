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
 * How much of a free-text message is kept.
 *
 * A stack trace or a driver's dump of the statement it choked on runs to kilobytes, and every one of
 * them is written to a table with no delete path. The first two thousand characters carry the
 * sentence a person reads; the rest is the part that makes an audit row expensive.
 */
const MAX_MESSAGE_CHARS = 2_000;

/**
 * Matches `password: "…"` and its spellings, anywhere in a free-text message.
 *
 * Built from {@link REDACTED_KEYS} so the two rules cannot drift: a name added to that list starts
 * being caught in prose as well as in structured fields. Separators are optional in the pattern for
 * the same reason they are stripped in {@link redact} — `new_password`, `newPassword` and
 * `NEWPASSWORD` are one name written three ways.
 *
 * **The value has to look like a secret, not merely follow a colon.** A pattern that took anything
 * after the separator turned `error code: 500` into `error code: [redacted]` and `password: too
 * short` into a sentence that no longer says what was wrong — destroying the diagnostic this
 * function exists alongside, on a line that never carried a secret. So a value counts only if it is
 * quoted, which is how a database driver renders a string argument, or is a long unbroken run of
 * characters, which is what a hash or a token looks like and what prose does not.
 */
const SECRET_VALUE = ['"[^"]*"', "'[^']*'", "`[^`]*`", "[^\\s,;)}\\]]{16,}"].join("|");
const MESSAGE_SECRET_PATTERN = new RegExp(
	`\\b(${REDACTED_KEYS.map((key) => key.split("").join("[-_ ]?")).join("|")})\\b\\s*[:=]\\s*(${SECRET_VALUE})`,
	"gi",
);

/**
 * Scrubs a free-text message and caps its length.
 *
 * {@link redact} covers structured fields, which is most of what this system writes — but not all of
 * it. An error's `message` is one string, and the string a database driver builds can contain the
 * arguments it was called with: a failed password change reports the statement it tried, hash
 * included, and that message is written into an audit row's `detail` and into the process log. The
 * recovery CLI's own code says exactly this about Prisma errors and avoids printing them; this is
 * the same care applied to every path that keeps one.
 *
 * A regular expression over prose is a backstop, not a guarantee — it catches the shape these
 * messages actually take, and the length cap bounds what a message that outsmarts it can cost.
 *
 * @param text the message as it came
 * @returns the message with recognisable secrets replaced, truncated to a storable length
 */
export function redactMessage(text: string): string {
	const scrubbed = text.replace(MESSAGE_SECRET_PATTERN, (_match, key: string) => `${key}: ${REDACTION_MARKER}`);
	return scrubbed.length > MAX_MESSAGE_CHARS ? `${scrubbed.slice(0, MAX_MESSAGE_CHARS)}${TRUNCATION_MARKER}` : scrubbed;
}

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
	if (typeof value === "string") {
		// Strings are where a secret hides in prose rather than in a field name — an error message
		// quoting the statement that failed, say. See {@link redactMessage}.
		return redactMessage(value);
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
