import "server-only";
import type { ApiRouteEntry } from "@/lib/api/api-routes";
import type { LogLevel } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import type { AuthenticatedKey } from "@/lib/keys/authenticate";
import { logger } from "@/lib/logger";
import { recordServerLog } from "@/lib/logs/log-service";
import { booleanSetting } from "@/lib/settings/settings-service";

/**
 * Turning one settled API request into one line an operator can read.
 *
 * Separated from `api-route.ts` because the two answer different questions. That module decides
 * whether a request may proceed and what its response is; this one decides only how the attempt
 * reads afterwards, which is where every judgement about wording and severity lives.
 *
 * **The level is the outcome.** Nothing else on a `LogEntry` row says how a request ended, so the
 * level filter in the Logs tab is the only way to ask "what was refused today" without reading every
 * message. That makes a refusal recorded as `ERROR`, or a fault recorded as `WARN`, a defect rather
 * than a matter of taste.
 */

/**
 * The statuses that mean an access control said no.
 *
 * By status rather than by code, so a new `403` added to `lib/errors.ts` is classified as the
 * refusal it is without anyone remembering to widen a list here. `401` is included even though the
 * request carried no usable credential: a burst of them is the shape credential stuffing has, and it
 * is exactly what an operator asked "why can my till not print" needs to see.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

/** What the line is attributed to, beyond the key the wrapper already knows. */
export interface ApiLogTarget {
	agentId?: string;
	agentName?: string;
	deviceId?: string;
	deviceName?: string;
}

/**
 * How a request ended.
 *
 * A union rather than an optional `error`, so "the handler returned" and "the handler threw
 * undefined" cannot be confused for one another — the first decides `INFO` and the second must not.
 */
export type ApiRequestOutcome =
	| {
			status: "returned";
			/** The handler's own sentence, written for a person. */
			message: string;
			target?: ApiLogTarget;
	  }
	| { status: "threw"; error: unknown };

/**
 * Records one line for a settled request, unless it is a successful read the install asked not to
 * keep.
 *
 * **The gate is consulted after the outcome, never before.** `logs.recordApiReads` suppresses noise,
 * not evidence: a till polling `GET /v1/status` once a second produces 86,400 rows a day and none of
 * them say anything, while a *refused* read is the whole reason someone opens the Logs tab. Deciding
 * up front that "this is a read, so stay quiet" is the shorter way to write this function and it
 * throws away the refusals along with the noise.
 *
 * **Nothing here guards against a failed write.** {@link recordServerLog} never throws and truncates
 * to `logs.maxMessageChars` itself; a second `try` around it would only be a place for a future
 * reader to wonder which of the two is load-bearing. The *settings read* above it is a different
 * matter and is guarded — see {@link recordsSuccessfulReads}.
 *
 * **An unauthenticated request still leaves a line, and nothing bounds how many.** `requireApiRead`
 * runs inside the handlers, which is past the point a `401` gets to, so a caller with no credential
 * can write one row per request until `logs.retentionDays` sweeps them. That is a real cost, taken
 * knowingly: a `401` that leaves no trace is exactly the request an operator asked "why has this till
 * stopped printing" cannot diagnose. The row names no key, because there is no key to name.
 *
 * @param entry the route's registry entry
 * @param key the authenticated caller, or null when authentication itself is what failed
 * @param outcome how the request ended
 */
export async function recordApiRequest(
	entry: ApiRouteEntry,
	key: AuthenticatedKey | null,
	outcome: ApiRequestOutcome,
): Promise<void> {
	if (outcome.status === "returned" && entry.kind === "query" && !(await recordsSuccessfulReads())) {
		return;
	}

	await recordServerLog(levelFor(outcome), messageFor(entry, key, outcome), {
		...(outcome.status === "returned" ? outcome.target : {}),
		...(key ? { apiKeyId: key.id } : {}),
	});
}

/**
 * Whether this install keeps its successful reads.
 *
 * **Guarded, and the guard is not the one the brief warned against.** That warning is about wrapping
 * {@link recordServerLog}, which already never throws; this wraps `booleanSetting`, which is a bare
 * `prisma.setting.findMany` with nothing between it and the caller. That call runs *inside*
 * `apiRoute`'s own `try`, so an unguarded read that threw would be caught there and turn a request
 * that had already succeeded into a `500` — the precise thing `recordServerLog`'s contract promises
 * never to do to a caller, broken one statement above the call that promises it.
 *
 * **A read that fails answers "record it."** Suppression is the branch that throws information away,
 * so it must not be what an unreadable rule defaults to — the same instinct `panelAction`'s gate
 * follows when a permission is missing. It costs at most one extra row, on an install whose settings
 * table is already failing to read, and {@link recordServerLog} swallows its own failure if the
 * database is unwell enough that the row cannot be written either.
 *
 * @returns the value of `logs.recordApiReads`, or true when it cannot be read
 */
async function recordsSuccessfulReads(): Promise<boolean> {
	try {
		return await booleanSetting("logs.recordApiReads");
	} catch (error) {
		logger.warn("Could not read logs.recordApiReads; recording this read rather than dropping it", {
			error: String(error),
		});
		return true;
	}
}

/**
 * The `404`s that are authorization decisions wearing a 404's clothes.
 *
 * Both are returned for a resource the key may not see *precisely* so the answer is
 * indistinguishable from one that does not exist — `lib/errors.ts` says so for `unknown_device`, and
 * `app/api/v1/jobs/[id]/route.ts` says it verbatim for `unknown_job`: "distinguishing them would
 * confirm that an identifier exists". Filed under refusals, because an operator asking "what did
 * this key get turned away from" must see both beside the `403`s; left at `ERROR`, id probing would
 * sit among the server's own faults, which is not where anybody looks for it.
 *
 * **The other two `404`s are deliberately not here.** `unknown_asset` is not an authorization
 * decision at all: assets are install-wide, so `assets:read` and `assets:write` grant the whole
 * namespace and a 404 there means the image genuinely is not stored — filing that as a refusal would
 * put "no such image" beside the probing and dilute the one filter that answers for it.
 * `unknown_agent` is raised by the panel's own services and never by a v1 route, so listing it would
 * be a rule about a case that cannot arise, which is worse than no rule.
 */
const REFUSALS_REPORTED_AS_NOT_FOUND: ReadonlySet<string> = new Set(["unknown_device", "unknown_job"]);

/**
 * Which level carries this outcome.
 *
 * Refusals are recognised by status, so a new `403` in `lib/errors.ts` is classified as one without
 * anyone widening a list — except for the `404`s in {@link REFUSALS_REPORTED_AS_NOT_FOUND}, which
 * cannot be told from a genuine miss by their status and are therefore named.
 *
 * @param outcome how the request ended
 * @returns the level to record it at
 */
function levelFor(outcome: ApiRequestOutcome): LogLevel {
	if (outcome.status === "returned") {
		return "INFO";
	}
	if (!(outcome.error instanceof ApiError)) {
		return "ERROR";
	}
	if (REFUSALS_REPORTED_AS_NOT_FOUND.has(outcome.error.code)) {
		return "WARN";
	}
	return REFUSAL_STATUSES.has(outcome.error.status) ? "WARN" : "ERROR";
}

/**
 * The line's text.
 *
 * **A success is described by the handler, not by this function.** "Printed 24 lines to bar-printer"
 * is what an operator wants; a sentence assembled from `entry.id` would make the Logs tab a
 * restatement of the URL, which the request already is. Only a request that never reached its
 * handler — or died inside one — is described from the registry, because at that point there is
 * nothing else that knows what was being attempted.
 *
 * **The key's name goes last and is appended here rather than by each handler.** `LogEntry` carries
 * `apiKeyId` with no denormalised name column (see `recordServerLog`), so the name has to be in the
 * message for the line to still mean something once the key is deleted — and putting it at the end
 * is what keeps the outcome inside `logs.maxMessageChars`, whose floor is 200, when a key and a
 * device both spend 64 characters of that budget. The same reasoning the raw-write route's own audit
 * line is built on.
 *
 * The verb is read back out of {@link levelFor} rather than decided again here, so a line that says
 * "refused" is a line recorded at `WARN` by construction. Deciding it twice would let the word and
 * the level drift, and the two are the same claim written for two different readers.
 *
 * @param entry the route's registry entry
 * @param key the authenticated caller, or null when authentication itself is what failed
 * @param outcome how the request ended
 * @returns the message to store
 */
function messageFor(entry: ApiRouteEntry, key: AuthenticatedKey | null, outcome: ApiRequestOutcome): string {
	const attribution = key ? ` (key '${key.name}')` : "";

	if (outcome.status === "returned") {
		return `${outcome.message}${attribution}`;
	}

	const { error } = outcome;
	if (error instanceof ApiError) {
		const verb = levelFor(outcome) === "WARN" ? "refused" : "failed";
		return `${routeLabel(entry)} ${verb}: ${error.code}. ${error.message}${attribution}`;
	}

	// Reported under the code the caller was answered with, so the row and the response agree about
	// what happened. The underlying message is kept because this row is read by an operator and not
	// by the caller — `toErrorResponse` is what makes sure the caller never sees it.
	const detail = error instanceof Error ? error.message : String(error);
	return `${routeLabel(entry)} failed: internal_error. ${detail}${attribution}`;
}

/**
 * How a route is named to a person.
 *
 * The registry's `api:` prefix namespaces the id. In a sentence it is noise, so it is dropped and
 * the method and path are left exactly as the registry writes them, `{agent}` and all: the template
 * is what a filter on "this route" matches, which an interpolated path would not be — see
 * `API_ROUTES`' own note on ids built from real names.
 *
 * @param entry the route's registry entry
 * @returns the id without its namespace, e.g. `GET /v1/jobs`
 */
function routeLabel(entry: ApiRouteEntry): string {
	return entry.id.startsWith("api:") ? entry.id.slice("api:".length) : entry.id;
}
