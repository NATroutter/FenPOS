import "server-only";
import { metricsDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
	addSample,
	emptyHistogram,
	type Histogram,
	mergeInto,
	parseHistogram,
	serializeHistogram,
} from "@/lib/metrics/histogram";
import { hourStart } from "@/lib/metrics/rollup";
import { globalStatsSettings } from "@/lib/settings/settings-service";

/**
 * Live, in-memory counters for API traffic and auth events, flushed into the metrics database
 * every 60 seconds.
 *
 * **Why in-memory rather than a write per request.** A keyed v1 request already pays for
 * `recordApiRequest`'s own write; adding a synchronous database write to every request purely to
 * count it would double that cost for a number nobody reads more often than once a minute. Instead
 * a request bumps an in-memory counter — cheap enough to happen on the hot path unconditionally —
 * and a 60 s timer drains it into the hourly rollup tables the Statistics page reads.
 *
 * **Why the maps are swapped before the flush writes anything.** `flushMetricCounters` replaces
 * both maps with empty ones synchronously, before its first `await`. A sample recorded while the
 * flush's database writes are in flight lands in the new map, not the one being drained, so it is
 * never lost and never double-counted.
 *
 * **This module must never import from `lib/audit/`.** `lib/audit/audit-log.ts` calls
 * {@link recordAuthKind} after it writes an event, so an import the other way would be a cycle.
 * {@link authKindsForAudit} therefore takes the action and outcome as plain strings rather than the
 * `AUTH_AUDIT_ACTIONS` constants those strings come from.
 */

/** One kind of auth-adjacent event a live counter tracks. */
export type AuthKind =
	| "signin_success"
	| "signin_failed"
	| "twofactor_failed"
	| "denied_action"
	| "api_auth_failed"
	| "rate_limited"
	| "session_created";

interface ApiCounterEntry {
	count: number;
	durationSumMs: number;
	hist: Histogram;
}

/** Keyed `${bucketISO}|${route}|${statusClass}|${apiKeyId}`; `apiKeyId` is `""` when unauthenticated. */
let apiCounters = new Map<string, ApiCounterEntry>();

/** Keyed `${bucketISO}|${kind}`. */
let authCounters = new Map<string, number>();

/**
 * Cached `stats.enabled`/`stats.apiMetrics`, refreshed once per {@link startMetricsFlusher} tick
 * (or by a test calling {@link refreshMetricsGates} directly) rather than read per request or per
 * event — see the module comment.
 *
 * Both default true, matching the settings' own fallbacks, so a server that has not yet ticked
 * still counts.
 */
let statsEnabled = true;
let apiMetricsEnabled = true;

function apiCounterKey(bucketISO: string, route: string, statusClass: string, apiKeyId: string): string {
	return `${bucketISO}|${route}|${statusClass}|${apiKeyId}`;
}

function authCounterKey(bucketISO: string, kind: AuthKind): string {
	return `${bucketISO}|${kind}`;
}

function addApiSample(
	bucketISO: string,
	route: string,
	statusClass: string,
	apiKeyId: string,
	durationMs: number,
): void {
	const key = apiCounterKey(bucketISO, route, statusClass, apiKeyId);
	let entry = apiCounters.get(key);
	if (!entry) {
		entry = { count: 0, durationSumMs: 0, hist: emptyHistogram() };
		apiCounters.set(key, entry);
	}
	entry.count += 1;
	entry.durationSumMs += durationMs;
	addSample(entry.hist, durationMs);
}

/**
 * Records one API v1 response, in-memory.
 *
 * Also records the rejection pseudo-routes: a 401/403 additionally counts under `reject:auth` and
 * bumps {@link recordAuthKind}`("api_auth_failed")`; a 429 additionally counts under
 * `reject:rate-limit` and bumps `"rate_limited"`; a 400/422 additionally counts under
 * `reject:validation`. Each pseudo-route entry shares the real request's `statusClass` and
 * `apiKeyId`, so a rejection breakdown can still be sliced by key.
 *
 * Synchronous and never throws: a fault here must cost a request nothing, so every step past the
 * `stats.enabled`/`stats.apiMetrics` gate is wrapped in its own `try`/`catch`.
 *
 * @param sample the completed request — `apiKeyId` is null when the request never authenticated
 */
export function recordApiMetric(sample: {
	route: string;
	status: number;
	apiKeyId: string | null;
	durationMs: number;
}): void {
	if (!statsEnabled || !apiMetricsEnabled) {
		return;
	}

	try {
		const bucketISO = hourStart(new Date()).toISOString();
		const statusClass = `${Math.floor(sample.status / 100)}xx`;
		const apiKeyId = sample.apiKeyId ?? "";

		addApiSample(bucketISO, sample.route, statusClass, apiKeyId, sample.durationMs);

		if (sample.status === 401 || sample.status === 403) {
			addApiSample(bucketISO, "reject:auth", statusClass, apiKeyId, sample.durationMs);
			recordAuthKind("api_auth_failed");
		} else if (sample.status === 429) {
			addApiSample(bucketISO, "reject:rate-limit", statusClass, apiKeyId, sample.durationMs);
			recordAuthKind("rate_limited");
		} else if (sample.status === 400 || sample.status === 422) {
			addApiSample(bucketISO, "reject:validation", statusClass, apiKeyId, sample.durationMs);
		}
	} catch (error) {
		logger.error("Could not record an API metric sample", error, { route: sample.route, status: sample.status });
	}
}

/**
 * Records one auth-adjacent event, in-memory.
 *
 * Gated on `stats.enabled` alone — there is no auth-specific switch, unlike API traffic's
 * `stats.apiMetrics` — via the same cached boolean {@link recordApiMetric} reads.
 *
 * Synchronous and never throws, for the same reason as {@link recordApiMetric}: this is called from
 * `lib/audit/audit-log.ts` on the audit write's own hot path.
 */
export function recordAuthKind(kind: AuthKind): void {
	if (!statsEnabled) {
		return;
	}

	try {
		const bucketISO = hourStart(new Date()).toISOString();
		const key = authCounterKey(bucketISO, kind);
		authCounters.set(key, (authCounters.get(key) ?? 0) + 1);
	} catch (error) {
		logger.error("Could not record an auth counter", error, { kind });
	}
}

// Mirrors `AUTH_AUDIT_ACTIONS.SIGN_IN` in lib/audit/auth-events.ts. Written as a literal rather
// than imported from there: `lib/audit/audit-log.ts` calls into this module, and an import back
// the other way would be a cycle — see the module comment.
const SIGN_IN_ACTION = "auth:sign-in";
// Mirrors `AUTH_AUDIT_ACTIONS.TWO_FACTOR` in lib/audit/auth-events.ts, same reason.
const TWO_FACTOR_ACTION = "auth:two-factor";

/**
 * Maps one audit event to the {@link AuthKind}s it should bump, if any.
 *
 * Pure — no recording happens here, so a caller can call it freely to check what an event would
 * map to. Rules are tried in order and the first match wins: a sign-in that was `DENIED` still
 * matches "sign-in, not success" rather than falling through to the generic `DENIED` rule, and
 * likewise for a two-factor challenge.
 *
 * @param action the audit action id, e.g. `auth:sign-in`
 * @param outcome the audit outcome, e.g. `SUCCESS`
 * @returns zero or more kinds to record
 */
export function authKindsForAudit(action: string, outcome: string): AuthKind[] {
	if (action === SIGN_IN_ACTION) {
		return outcome === "SUCCESS" ? ["signin_success", "session_created"] : ["signin_failed"];
	}
	if (action === TWO_FACTOR_ACTION) {
		return outcome === "SUCCESS" ? [] : ["twofactor_failed"];
	}
	if (outcome === "DENIED") {
		return ["denied_action"];
	}
	return [];
}

/**
 * Drains both in-memory maps into the metrics database, additively.
 *
 * The maps are swapped for empty ones first — see the module comment for why — so every write
 * below operates on a private snapshot no concurrent {@link recordApiMetric} or
 * {@link recordAuthKind} call can touch.
 *
 * Each API entry needs its stored histogram merged with what is already flushed for that bucket,
 * which `upsert` alone cannot express — an `update` cannot read the row it is about to write — so
 * each entry does its own `findUnique`, merges in memory, then `upsert`s the merged JSON alongside
 * plain `increment`s for `count` and `durationSumMs`. There are only ever a handful of distinct
 * keys per minute, so the extra round trip per entry costs nothing this cadence cares about.
 *
 * Auth entries need no such read: `count` alone increments cleanly through `upsert`.
 */
export async function flushMetricCounters(): Promise<void> {
	const apiSnapshot = apiCounters;
	const authSnapshot = authCounters;
	apiCounters = new Map();
	authCounters = new Map();

	for (const [key, entry] of apiSnapshot) {
		const [bucketISO, route, statusClass, apiKeyId] = key.split("|");
		const bucket = new Date(bucketISO);
		const where = { bucket_route_statusClass_apiKeyId: { bucket, route, statusClass, apiKeyId } };

		// Only merged when a row already exists: the `create` branch below writes `entry.hist`
		// verbatim, so computing a merge for it would be wasted work.
		const existing = await metricsDb.metricApiHourly.findUnique({ where });
		let updateHist = serializeHistogram(entry.hist);
		if (existing) {
			const merged = parseHistogram(existing.durationHist);
			mergeInto(merged, entry.hist);
			updateHist = serializeHistogram(merged);
		}

		await metricsDb.metricApiHourly.upsert({
			where,
			create: {
				bucket,
				route,
				statusClass,
				apiKeyId,
				count: entry.count,
				durationSumMs: entry.durationSumMs,
				durationHist: serializeHistogram(entry.hist),
			},
			update: {
				count: { increment: entry.count },
				durationSumMs: { increment: entry.durationSumMs },
				durationHist: updateHist,
			},
		});
	}

	for (const [key, count] of authSnapshot) {
		const [bucketISO, kind] = key.split("|");
		const bucket = new Date(bucketISO);

		await metricsDb.metricAuthHourly.upsert({
			where: { bucket_kind: { bucket, kind } },
			create: { bucket, kind, count },
			update: { count: { increment: count } },
		});
	}
}

/**
 * Refreshes {@link statsEnabled} and {@link apiMetricsEnabled} from `stats.enabled` and
 * `stats.apiMetrics`, in one settings read.
 *
 * **When the master switch is off, this also discards both in-memory maps.** `stats.enabled`'s own
 * description is "Master switch. When off, nothing samples, counts or rolls up" — and
 * {@link recordApiMetric}/{@link recordAuthKind} refusing to add anything new is only half of that:
 * without this, whatever was recorded before the switch flipped would sit in memory forever (the
 * flusher's tick would never drain it while disabled, and every subsequent hour would still not be
 * flushed), which is unbounded growth for as long as the switch stays off. Discarding it here means
 * nothing lingers, and nothing stale flushes the moment the switch is turned back on.
 *
 * Exported so `startMetricsFlusher`'s tick and a test can share the one place this decision is
 * made — a test can drive the gate directly rather than waiting on the tick's own interval.
 *
 * @returns the refreshed gates
 */
export async function refreshMetricsGates(): Promise<{ enabled: boolean; apiMetrics: boolean }> {
	const stats = await globalStatsSettings();
	statsEnabled = stats.enabled;
	apiMetricsEnabled = stats.apiMetrics;

	if (!statsEnabled) {
		apiCounters = new Map();
		authCounters = new Map();
	}

	return { enabled: statsEnabled, apiMetrics: apiMetricsEnabled };
}

/**
 * Starts the recurring pass that flushes the live counters into the metrics database.
 *
 * Ticks every 60 s, `unref()`'d and skip-while-running, following the same pattern as
 * `startDeliveryDrain` and `startMaintenance` in `instrumentation-runtime.ts`: never fatal, and a
 * slow flush cannot stack a second one on top of itself.
 *
 * Every tick calls {@link refreshMetricsGates} first, which is what lets {@link recordApiMetric} and
 * {@link recordAuthKind} gate themselves without a per-event database read. The flush itself only
 * runs while `stats.enabled` — the master switch — is on; while it is off nothing has been recorded
 * since the gate closed (see {@link refreshMetricsGates}), so there is nothing to flush.
 */
export function startMetricsFlusher(): void {
	let running = false;

	const tick = (): void => {
		if (running) {
			return;
		}
		running = true;
		(async () => {
			const { enabled } = await refreshMetricsGates();
			if (enabled) {
				await flushMetricCounters();
			}
		})()
			.catch((error) => {
				logger.error("A metrics counter flush could not run", error);
			})
			.finally(() => {
				running = false;
			});
	};

	const timer = setInterval(tick, 60_000);
	timer.unref();
}
