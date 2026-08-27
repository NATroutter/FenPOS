import "server-only";
import { isIP } from "node:net";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { blockedReason } from "@/lib/net/address-rules";
import { booleanSetting, integerSetting } from "@/lib/settings/settings-service";
import { signPayload } from "@/lib/webhooks/signature";

/**
 * Sending queued deliveries, and deciding what a failure means.
 *
 * **A receiver that is down and a receiver that is refusing are different facts.** A 5xx or a
 * timeout is worth retrying — the target may be restarting, and a notification that arrives late is
 * still worth having. A 4xx is not: a target that rejects the shape of a delivery will reject the
 * same bytes just as firmly in ten minutes, and retrying is load with no prospect of success. 408
 * and 429 are the exceptions, because both explicitly say "later".
 *
 * On the SSRF question: the target is registered by an administrator through the panel, not chosen
 * by an API caller, which is a materially weaker threat model than `<image>` URLs face. The address
 * check still runs before every attempt — a hostname's answer can change between registration and
 * delivery — but this deliberately stops short of the connection pinning `fetchRemoteImage` does.
 *
 * **The residual is bigger than "a DNS answer changing between this check and the connection"
 * sounds.** `targetRefusal`'s resolution and the `fetch` that follows it are two independent
 * lookups, not one pinned to the other, so an attacker holding a low-TTL record that alternates
 * between a safe and an unsafe address is not threading a narrow race — each attempt is roughly a
 * coin flip, and a delivery that fails is retried up to `webhooks.maxAttempts` times, each its own
 * flip. It is also not a read the way `fetchRemoteImage`'s target is: this is a `POST` carrying a
 * signed body to whatever the second lookup answered. What actually bounds this is the
 * precondition, not the odds once it holds — reaching it requires already controlling both an
 * operator's webhook URL and the DNS answering for it.
 *
 * **Overlapping passes must not send the same delivery twice.** Task 11 calls {@link deliverDue} on
 * a timer, so a pass that is still working through a slow batch can still be running when the next
 * one fires. Claiming a row is not enough on its own: an earlier version of this module claimed only
 * by bumping `attempts`, which stops two passes claiming the row *at the same instant* but does
 * nothing once the winner is mid-flight — the row is still `PENDING` and still due, so the *next*
 * pass to run `findMany` finds it, claims it again (the CAS matches the winner's now-current
 * `attempts`), and sends it a second time while the first send is still in the air. The fix is a
 * lease: the same `UPDATE` that wins the claim also pushes `nextAttemptAt` out past this attempt's
 * worst-case duration, so the row drops out of every other pass's due set for as long as it is
 * actually being worked. Every outcome path (delivered, retried, given up) overwrites `nextAttemptAt`
 * or `status` before returning, so the lease is invisible on the happy path — it only matters if the
 * process dies mid-attempt, in which case the row simply becomes due again once the lease expires,
 * which is the same "never permanently unclaimable" property the plain CAS had.
 *
 * **One hostile target must not stall the rest of the batch.** A batch is sent concurrently
 * ({@link Promise.all} over {@link processDelivery}), not one delivery after another — each attempt
 * is already bounded by `webhooks.timeoutMs` on its own, so running the batch concurrently bounds
 * the whole pass by the slowest single attempt instead of by their sum. A delivery that throws
 * something unexpected (not a rejected `send`, which is already handled, but e.g. a database error)
 * is caught inside {@link processDelivery} rather than left to reject its place in the `Promise.all`
 * — this function runs on a timer with nobody to catch it, so one bad row must not cost every other
 * delivery in the same pass. The same reasoning applies one level up: {@link deliverDue}'s own setup
 * (reading `webhooks.enabled`, the due query, reading the rest of the settings) is a database round
 * trip too, and a transient failure there must resolve to 0 rather than reject into a caller that,
 * being a timer, has nobody to catch it either.
 */

/** How one delivery reaches its target. A seam: tests pass their own, production passes none. */
export type Sender = (url: string, body: string, signature: string, timeoutMs: number) => Promise<{ status: number }>;

/** How many deliveries one pass will attempt, so a large backlog cannot occupy the process. */
const BATCH = 20;

/** Statuses that mean "try again later" despite being 4xx. */
const RETRYABLE_CLIENT_STATUSES: readonly number[] = [408, 429];

/** The two terminal `WebhookDelivery.status` values a sweep may remove. `PENDING` never is. */
const SETTLED_DELIVERY_STATUSES: readonly string[] = ["DELIVERED", "FAILED"];

/**
 * The longest a single retry may be scheduled out, in seconds.
 *
 * `webhooks.retryBackoffSeconds` and `webhooks.maxAttempts` are each bounded on their own (up to an
 * hour, up to 20 attempts), but the doubling between them is not — an install turning both dials to
 * their ceiling would otherwise compute a wait of `3600 * 2^18` seconds for its last retry, on the
 * order of decades. A day is generous for "the receiver might come back" while still meaning
 * `nextAttemptAt` is always a date an operator looking at it would recognise as a retry, not a typo.
 */
const MAX_BACKOFF_SECONDS = 24 * 60 * 60;

/**
 * Extra time added on top of an attempt's worst-case duration when leasing a delivery — see
 * {@link processDelivery}.
 *
 * An attempt's own worst case is bounded by settings (DNS resolution up to `webhooks.timeoutMs`, then
 * the send itself up to `webhooks.timeoutMs` again — see {@link resolveHostname}), but the lease also
 * has to cover everything settings don't: the claim write, the two address checks, and the final
 * write, all real database round trips. Five seconds is generous for that on the local SQLite this
 * schema runs against — these are all single-row writes and reads — while staying small relative to
 * even the shortest `webhooks.timeoutMs` window this matters for. Sized as a flat addition rather
 * than a percentage: the overhead it covers doesn't scale with `timeoutMs`, so a percentage would
 * either be too tight at the low end or absurdly generous at the high end.
 */
const LEASE_MARGIN_MS = 5_000;

/**
 * Settings read once per pass and threaded through {@link processDelivery} for every delivery in
 * it.
 *
 * `webhooks.allowPlainHttp` is not among them: it belongs to the target check, and that check now
 * lives in {@link assertDeliverable}, which reads it itself — see that function's doc comment for
 * why it is not passed in from here instead.
 */
interface DeliverySettings {
	timeoutMs: number;
	maxAttempts: number;
	backoffSeconds: number;
	/** `webhooks.maxDeliveryRecords`: settled deliveries kept before the oldest are swept. */
	maxDeliveryRecords: number;
	/** `webhooks.deliverySweepEvery`: how many settled deliveries pass between retention sweeps. */
	deliverySweepEvery: number;
}

/**
 * Sends every delivery that is due.
 *
 * @param now current time; injectable so tests need no sleeps
 * @param send how to reach the target; omit for the real one
 * @returns how many deliveries were attempted
 */
export async function deliverDue(now: Date = new Date(), send: Sender = httpSender): Promise<number> {
	try {
		if (!(await booleanSetting("webhooks.enabled"))) {
			return 0;
		}

		const due = await prisma.webhookDelivery.findMany({
			where: {
				status: "PENDING",
				nextAttemptAt: { lte: now },
				// A disabled webhook, or one whose key has been revoked, must not occupy the front of this
				// queue forever: without this filter its rows stay PENDING and due, so — oldest first —
				// they sort ahead of every row behind them on every later pass, and BATCH of them is enough
				// to starve delivery entirely. Filtered again inside processDelivery too; see there for why.
				webhook: { enabled: true, apiKey: { revokedAt: null } },
			},
			orderBy: { nextAttemptAt: "asc" },
			take: BATCH,
			include: { webhook: { select: { url: true, secret: true, enabled: true } } },
		});

		const [timeoutMs, maxAttempts, backoffSeconds, maxDeliveryRecords, deliverySweepEvery] = await Promise.all([
			integerSetting("webhooks.timeoutMs"),
			integerSetting("webhooks.maxAttempts"),
			integerSetting("webhooks.retryBackoffSeconds"),
			integerSetting("webhooks.maxDeliveryRecords"),
			integerSetting("webhooks.deliverySweepEvery"),
		]);
		const settings: DeliverySettings = {
			timeoutMs,
			maxAttempts,
			backoffSeconds,
			maxDeliveryRecords,
			deliverySweepEvery,
		};

		// Concurrently, not one after another — see the module comment on why a slow target must not
		// hold up the rest of the batch. Every element resolves (never rejects; see processDelivery),
		// so Promise.all cannot itself throw here.
		const attempted = await Promise.all(due.map((delivery) => processDelivery(delivery, now, send, settings)));

		return attempted.filter(Boolean).length;
	} catch (error) {
		// This runs on a timer with nobody to catch a rejection — see the module comment. Everything
		// above this point is a database round trip (the enabled check, the due query, the settings
		// read), any of which can fail transiently, and a failure here must cost this pass rather than
		// the ability to ever run again.
		logger.error("A webhook delivery pass could not run", error);
		return 0;
	}
}

/**
 * Claims and processes one delivery, isolated from every other delivery in the same pass.
 *
 * Never throws: a rejected `send` is already handled inside, and anything else unexpected — a
 * database error, say — is caught here so it cannot take down the `Promise.all` in
 * {@link deliverDue} and abandon the rest of the batch. Logged rather than silently dropped, so a
 * fault of that kind is still visible to an operator even though it costs this delivery nothing more
 * than waiting for the next pass to try again.
 *
 * @param delivery a due delivery, with its webhook joined in
 * @param now current time, shared with every delivery in this pass
 * @param send how to reach the target
 * @param settings the settings this pass is running under
 * @returns whether this delivery was actually attempted by this pass — false when its webhook is
 *          disabled, or when another pass claimed it first
 */
async function processDelivery(
	delivery: {
		id: string;
		jobId: string;
		attempts: number;
		payload: string;
		webhook: { url: string; secret: string; enabled: boolean };
	},
	now: Date,
	send: Sender,
	settings: DeliverySettings,
): Promise<boolean> {
	try {
		if (!delivery.webhook.enabled) {
			// Also filtered in deliverDue's due query — see the comment there for why a row must not
			// reach even a claim attempt once its webhook is disabled. Kept here too because a webhook
			// can be disabled in the window between that query running and this row's claim.
			return false;
		}

		const attempts = delivery.attempts + 1;
		// Never the full URL — a registered target can carry credentials in its query string, and the
		// host is what actually diagnoses a failing delivery. See the logging in settleFailed.
		const host = hostOf(delivery.webhook.url);
		const retryOptions = {
			now,
			maxAttempts: settings.maxAttempts,
			backoffSeconds: settings.backoffSeconds,
			maxDeliveryRecords: settings.maxDeliveryRecords,
			deliverySweepEvery: settings.deliverySweepEvery,
		};

		// The claim is a lease, not just a compare-and-swap: matching `attempts` is what decides which
		// of however many overlapping passes wins the row, but the same UPDATE also pushes
		// `nextAttemptAt` past this attempt's worst case (DNS resolution, then the send itself — see
		// resolveHostname and MAX_BACKOFF_SECONDS's sibling comment on LEASE_MARGIN_MS) so the row
		// drops out of every *other* pass's due set for as long as this one might still be working it.
		// Every path below overwrites nextAttemptAt or status before returning, so this value is never
		// actually read back — it only matters if this process dies before reaching one of them.
		const leaseUntil = new Date(now.getTime() + settings.timeoutMs * 2 + LEASE_MARGIN_MS);
		const claim = await prisma.webhookDelivery.updateMany({
			where: { id: delivery.id, status: "PENDING", attempts: delivery.attempts },
			data: { attempts, nextAttemptAt: leaseUntil },
		});
		if (claim.count === 0) {
			return false;
		}

		try {
			await assertDeliverable(delivery.webhook.url);
		} catch (error) {
			// Most refusals are permanent — the target is wrong rather than unavailable, and no number
			// of attempts will make an address this server must not reach into one it may. The one
			// exception is a resolution timeout, which targetRefusal marks non-permanent because it is
			// a transient fact about this attempt, not about the hostname. `permanent` is threaded
			// through recordFailure the same way a status code's is, rather than a mechanism of its own.
			const reason = error instanceof ApiError ? error.message : String(error);
			const permanent = !(error instanceof ApiError && error.details.permanent === false);
			await recordFailure(delivery.id, delivery.jobId, host, attempts, reason, { ...retryOptions, permanent });
			logger.warn("Refused to deliver a webhook", { deliveryId: delivery.id, reason, permanent });
			return true;
		}

		try {
			const { status } = await send(
				delivery.webhook.url,
				delivery.payload,
				signPayload(delivery.webhook.secret, delivery.payload, now),
				settings.timeoutMs,
			);

			if (status >= 200 && status < 300) {
				// Conditioned on the `attempts` this call claimed, not a plain update-by-id — see the
				// module comment on why the claim is a lease and not a mutual-exclusion guarantee. If this
				// attempt outlived its lease and a second pass already settled the row (won it, sent, and
				// recorded an outcome), that second write already advanced `attempts` past what this call
				// claimed, so this one matches nothing and a stale outcome cannot overwrite a real one.
				const settled = await prisma.webhookDelivery.updateMany({
					where: { id: delivery.id, attempts },
					data: { status: "DELIVERED", attempts, deliveredAt: now, lastError: null },
				});
				if (settled.count > 0) {
					void sweepDeliveriesOccasionally(settings.maxDeliveryRecords, settings.deliverySweepEvery);
				}
				return true;
			}

			// A 3xx is exactly as permanent as a 4xx here, not merely "not yet permanent": `fetch` is
			// called with `redirect: "manual"` (see httpSender below), so nothing ever follows it — a 301
			// answered now is still a 301 on the last attempt an hour from now. Only a 5xx (the receiver's
			// own fault, worth retrying) and 408/429 (which explicitly mean "later") are not permanent.
			const permanent = status < 500 && !RETRYABLE_CLIENT_STATUSES.includes(status);
			await recordFailure(delivery.id, delivery.jobId, host, attempts, `The receiver answered ${status}.`, {
				...retryOptions,
				permanent,
			});
		} catch (error) {
			await recordFailure(
				delivery.id,
				delivery.jobId,
				host,
				attempts,
				String(error instanceof Error ? error.message : error),
				{ ...retryOptions, permanent: false },
			);
		}
		return true;
	} catch (error) {
		// See the module comment: this pass must survive one delivery misbehaving in a way that is
		// not "the target answered badly" — the two ordinary failure paths above already return
		// normally. The claim is a lease now, not just a compare-and-swap, so a row reaching here does
		// not go straight back into the next pass's due set the way it once did — it stays PENDING at
		// whatever `leaseUntil` the claim pushed `nextAttemptAt` to, and only becomes due again once
		// that lease runs out.
		logger.error("Unexpected error delivering a webhook", error, { deliveryId: delivery.id });
		return false;
	}
}

/**
 * Validates a candidate webhook target, the same way {@link processDelivery} validates one it is
 * about to attempt.
 *
 * This is the one place `webhooks.allowPlainHttp` and the address rules are applied to a URL, and
 * it is shared by two callers with different timing: the Keys tab calls it once, at registration,
 * so an operator learns immediately that a target is unreachable rather than discovering it in a
 * failed-delivery log; {@link processDelivery} calls it again before every attempt, because a
 * hostname's answer can change between registration and delivery. Sharing the function is what
 * keeps those two moments in agreement — a target the panel accepted can never turn out to be one
 * delivery goes on to refuse, because there is only one implementation of "acceptable" to drift.
 *
 * Reads `webhooks.allowPlainHttp` and `webhooks.timeoutMs` itself rather than taking them as
 * parameters, which is what lets the signature stay a single `url` for both call sites — the
 * registration path has no batch of settings already in hand to pass through, and the delivery
 * path already pays for a `listSettings()` round trip per setting it reads (see the module's own
 * settings reads in {@link deliverDue}), so one more here costs it nothing structurally new.
 *
 * `details.permanent` on the thrown error is what {@link processDelivery} reads to decide whether a
 * refusal is worth retrying — see {@link targetRefusal}. `setWebhook` in `app/(panel)/keys/actions.ts`,
 * this function's other caller, ignores it and reads only `message`, which is fine: registration has
 * no retry loop to feed the distinction into.
 *
 * @param url the candidate target
 * @throws ApiError with code `webhook_unreachable` when the target must not be delivered to
 */
export async function assertDeliverable(url: string): Promise<void> {
	const [allowPlainHttp, timeoutMs] = await Promise.all([
		booleanSetting("webhooks.allowPlainHttp"),
		integerSetting("webhooks.timeoutMs"),
	]);
	const refusal = await targetRefusal(url, allowPlainHttp, timeoutMs);
	if (refusal !== null) {
		throw new ApiError("webhook_unreachable", refusal.reason, { permanent: refusal.permanent });
	}
}

/** Why a target must not be delivered to, and whether that is ever going to change. */
interface Refusal {
	reason: string;
	/**
	 * Whether retrying can never help. True for everything except a resolution timeout: a bad
	 * scheme, a blocked address, or a genuine "no such host" answer are facts about the target that
	 * the next attempt will find just as true, while a timeout is a fact about this attempt — see
	 * {@link resolveHostname}.
	 */
	permanent: boolean;
}

/**
 * Why this target must not be delivered to, if it must not be.
 *
 * @param url the registered target
 * @param allowPlainHttp whether the install permits http
 * @param timeoutMs how long address resolution may take — see {@link resolveHostname}
 * @returns the refusal, or null when the target is acceptable
 */
async function targetRefusal(url: string, allowPlainHttp: boolean, timeoutMs: number): Promise<Refusal | null> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return { reason: "the URL could not be parsed", permanent: true };
	}

	if (target.protocol !== "https:" && target.protocol !== "http:") {
		return { reason: `${target.protocol} is not a scheme this server delivers over`, permanent: true };
	}
	if (target.protocol === "http:" && !allowPlainHttp) {
		return { reason: "this install only delivers webhooks over https", permanent: true };
	}

	const hostname = target.hostname.replace(/^\[|\]$/g, "");
	if (hostname === "") {
		return { reason: "the URL names no host", permanent: true };
	}

	// A literal address needs no resolver; a hostname does. Both end at the same judgement, except a
	// resolver that timed out: resolveHostname throws ResolutionTimeoutError for that case instead of
	// folding it into its ordinary null return, precisely so this can tell "slow" from "no answer"
	// apart and refuse the former as non-permanent.
	let resolved: string[] | null;
	try {
		resolved = await resolveHostname(hostname, timeoutMs);
	} catch (error) {
		if (!(error instanceof ResolutionTimeoutError)) {
			throw error;
		}
		return { reason: `resolving ${hostname} timed out`, permanent: false };
	}
	if (resolved === null) {
		return { reason: `the hostname ${hostname} has no address`, permanent: true };
	}
	if (resolved.length === 0) {
		return { reason: `the hostname ${hostname} did not resolve to any address`, permanent: true };
	}

	for (const address of resolved) {
		const why = blockedReason(address);
		if (why !== null) {
			return { reason: `${hostname} resolves to ${address}, which is ${why}`, permanent: true };
		}
	}

	return null;
}

/**
 * Resolves a hostname to the addresses it currently points at.
 *
 * A literal IP is returned as itself without asking a resolver anything — there is nothing to
 * resolve, and it keeps the numeric case off the same path a lookup failure can affect. Imported
 * dynamically rather than at module scope only because nothing else in this module needs
 * `node:dns/promises`, and a webhook that never leaves an install where every target is a literal
 * address never pays for it.
 *
 * **Bounded by `timeoutMs`, not the OS resolver's own timeout.** `dns.lookup` carries no timeout of
 * its own — left alone it inherits whatever the platform resolver does, which can run well past the
 * `webhooks.timeoutMs` ceiling this module otherwise holds every attempt to. Raced against a timer,
 * but unlike a genuine lookup failure the timer winning is not folded into the same `null` return: it
 * rejects with {@link ResolutionTimeoutError}, which is rethrown rather than swallowed, so
 * {@link targetRefusal} can tell "DNS is slow" apart from "DNS has no answer" and refuse the former as
 * non-permanent — a receiver that is merely slow to answer deserves a retry, the way a 5xx does, not
 * the same permanent refusal a hostname with no address at all gets. What this cannot do is cancel the
 * underlying lookup: `dns.lookup` offers no abort signal, so a lookup that loses the race keeps
 * running in Node's resolver thread pool until it finishes on its own — this only bounds how long the
 * delivery *waits* for an answer, not how long the lookup itself runs.
 *
 * @param hostname the target's hostname, brackets already stripped
 * @param timeoutMs how long to wait for an answer before treating this as unresolvable
 * @returns every address it resolves to, or null when it does not resolve
 * @throws ResolutionTimeoutError when the timer wins the race before the resolver answers
 */
async function resolveHostname(hostname: string, timeoutMs: number): Promise<string[] | null> {
	if (isIP(hostname) !== 0) {
		return [hostname];
	}
	const timeout = rejectAfter(timeoutMs);
	try {
		const { lookup } = await import("node:dns/promises");
		const entries = await Promise.race([lookup(hostname, { all: true }), timeout.promise]);
		return entries.map((entry) => entry.address);
	} catch (error) {
		if (error instanceof ResolutionTimeoutError) {
			throw error;
		}
		return null;
	} finally {
		// The lookup winning the race is the common case, and leaves this timer with nothing left to
		// do — still pending, still unref'd, but otherwise free money not yet collected. Clearing it
		// here collects it, rather than leaving it to fire uselessly `timeoutMs` after a race it lost.
		timeout.cancel();
	}
}

/**
 * Raised by {@link rejectAfter} when its timer wins the race. A distinct type rather than a plain
 * `Error`, so {@link resolveHostname} can rethrow exactly this and nothing else — see its own doc
 * comment for why that distinction is what lets {@link targetRefusal} treat a slow resolver
 * differently from one that has genuinely answered "no such host".
 */
class ResolutionTimeoutError extends Error {}

/**
 * Rejects after `ms`, for racing against an operation that carries no timeout of its own.
 *
 * The timer is unref'd so a lookup that is still pending when the process would otherwise exit does
 * not hold it open on its own — but that alone does not stop it from firing: an unref'd timer still
 * runs, it just cannot keep the process alive on its own. `cancel` is for the caller to stop it
 * outright once the race is decided, so it does not go on to reject a race nobody is still awaiting.
 *
 * @param ms how long to wait before rejecting
 * @returns a promise that never resolves, only rejects with {@link ResolutionTimeoutError}, paired
 *   with a `cancel` to stop it from doing so
 */
function rejectAfter(ms: number): { promise: Promise<never>; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout>;
	const promise = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new ResolutionTimeoutError(`timed out after ${ms}ms`)), ms);
		timer.unref?.();
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Records a failed attempt, retrying or giving up.
 *
 * @param id the delivery
 * @param jobId the job this delivery is about, for {@link settleFailed}'s log line
 * @param host the target's host, for {@link settleFailed}'s log line — never the full URL, which can
 *   carry credentials in its query string
 * @param attempts the attempt just made, counted from one
 * @param reason what went wrong, stored for an operator to read
 * @param options the clock, the ceiling, the backoff, whether this failure is worth retrying, and the
 *   sweep settings to pass on to {@link settleFailed} when it is not
 */
async function recordFailure(
	id: string,
	jobId: string,
	host: string,
	attempts: number,
	reason: string,
	options: {
		now: Date;
		maxAttempts: number;
		backoffSeconds: number;
		permanent: boolean;
		maxDeliveryRecords: number;
		deliverySweepEvery: number;
	},
): Promise<void> {
	if (options.permanent || attempts >= options.maxAttempts) {
		await settleFailed(id, jobId, host, attempts, reason, options.maxDeliveryRecords, options.deliverySweepEvery);
		return;
	}

	// Doubling from the configured base: 10s, 20s, 40s… A receiver that is down for a few minutes is
	// not hammered while it recovers, and one that is down for an hour stops being retried at all.
	// Capped at MAX_BACKOFF_SECONDS — see its own comment for why the doubling alone is not enough.
	const waitSeconds = Math.min(options.backoffSeconds * 2 ** (attempts - 1), MAX_BACKOFF_SECONDS);

	// Conditioned on the `attempts` this call claimed — see the module comment and the DELIVERED write
	// above for why a plain update-by-id can clobber a second claimant's outcome, and why every outcome
	// write here guards against it the same way.
	await prisma.webhookDelivery.updateMany({
		where: { id, attempts },
		data: {
			attempts,
			lastError: reason,
			nextAttemptAt: new Date(options.now.getTime() + waitSeconds * 1000),
		},
	});
}

/**
 * Marks a delivery as given up on, and warns about it.
 *
 * The warning is the one place a failing webhook otherwise had no log output at all: a receiver
 * that answers 500 until `webhooks.maxAttempts` is exhausted, or answers a 4xx and is abandoned on
 * the first attempt, settled here either way with nothing printed before this existed. Logged only
 * when this call actually wins the write — see the `attempts` guard below — so a stale outcome that
 * lost to an earlier DELIVERED does not report a failure that never happened.
 *
 * @param id the delivery
 * @param jobId the job this delivery is about
 * @param host the target's host — never the full URL, which can carry credentials in its query string
 * @param attempts the attempt count to record
 * @param reason what went wrong
 * @param maxDeliveryRecords settled deliveries kept before the oldest are swept
 * @param deliverySweepEvery how many settled deliveries pass between sweeps
 */
async function settleFailed(
	id: string,
	jobId: string,
	host: string,
	attempts: number,
	reason: string,
	maxDeliveryRecords: number,
	deliverySweepEvery: number,
): Promise<void> {
	// Conditioned on `attempts` for the same reason the DELIVERED write above is — see the module
	// comment. A row this call no longer matches has already been settled by someone else, and this
	// write correctly becomes a no-op rather than overwriting a real outcome with a stale one.
	const settled = await prisma.webhookDelivery.updateMany({
		where: { id, attempts },
		data: { status: "FAILED", attempts, lastError: reason },
	});
	if (settled.count === 0) {
		return;
	}

	logger.warn("Webhook delivery failed permanently", { deliveryId: id, jobId, host, lastError: reason });
	void sweepDeliveriesOccasionally(maxDeliveryRecords, deliverySweepEvery);
}

/**
 * The registered target's `host` (hostname, plus port when the URL names one), for logging.
 *
 * Never the full URL: a target an operator registers can carry credentials in its query string, and
 * the host is what actually diagnoses a failing delivery — see {@link settleFailed} and the module
 * comment on `webhooks.allowPlainHttp`.
 *
 * @param url the webhook's registered target
 * @returns the host, or a placeholder on the URL this cannot happen for — `assertDeliverable` has
 *   already required the same URL to parse before any delivery reaches this function
 */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "(unparseable url)";
	}
}

const globalForDeliverySweep = globalThis as unknown as {
	fenposWebhookSettles: number | undefined;
};

/**
 * Counts one more settled delivery and sweeps once `webhooks.deliverySweepEvery` of them have
 * passed.
 *
 * The same shape `lib/logs/ingest.ts` uses for `logs.retentionDays`/`logs.sweepEvery` — counted in
 * writes rather than scheduled on a timer, so a quiet install sweeps nothing and a busy one sweeps
 * in proportion to what it is actually settling.
 *
 * @param maxRecords settled deliveries kept before the oldest are swept (`webhooks.maxDeliveryRecords`)
 * @param sweepEvery how many settled deliveries pass between sweeps (`webhooks.deliverySweepEvery`)
 */
async function sweepDeliveriesOccasionally(maxRecords: number, sweepEvery: number): Promise<void> {
	const settles = (globalForDeliverySweep.fenposWebhookSettles ?? 0) + 1;
	globalForDeliverySweep.fenposWebhookSettles = settles;

	if (settles % sweepEvery !== 0) {
		return;
	}

	await sweepDeliveriesNow(maxRecords);
}

/**
 * Sweeps `webhook_deliveries` down to `maxRecords`, deleting the oldest *settled* rows first.
 *
 * Scoped to {@link SETTLED_DELIVERY_STATUSES} only — `DELIVERED` and `FAILED` — never `PENDING`: a
 * delivery waiting on its first attempt or sitting out a retry backoff is not a candidate no matter
 * how old its row is, because sweeping it would silently drop a notification this server has not
 * finished trying to send.
 *
 * Exported so a test can trigger a sweep directly rather than settling `webhooks.deliverySweepEvery`
 * deliveries to reach the point at which {@link sweepDeliveriesOccasionally} would trigger it on its
 * own — the same reason `lib/logs/ingest.ts` exports `sweepLogsNow`.
 *
 * @param maxRecords settled deliveries kept before the oldest are swept
 */
export async function sweepDeliveriesNow(maxRecords: number): Promise<void> {
	try {
		const total = await prisma.webhookDelivery.count({ where: { status: { in: [...SETTLED_DELIVERY_STATUSES] } } });
		if (total <= maxRecords) {
			return;
		}

		const cutoff = await prisma.webhookDelivery.findMany({
			where: { status: { in: [...SETTLED_DELIVERY_STATUSES] } },
			orderBy: { createdAt: "desc" },
			skip: maxRecords - 1,
			take: 1,
			select: { createdAt: true },
		});

		if (cutoff.length > 0) {
			const removed = await prisma.webhookDelivery.deleteMany({
				where: { status: { in: [...SETTLED_DELIVERY_STATUSES] }, createdAt: { lt: cutoff[0].createdAt } },
			});
			logger.info("Swept old webhook deliveries", { removed: removed.count });
		}
	} catch (error) {
		// A failed sweep is not worth failing a delivery pass over; the next settle will try again.
		logger.warn("Could not sweep old webhook deliveries", { error: String(error) });
	}
}

/**
 * The real sender.
 *
 * @param url the target
 * @param body the signed payload text
 * @param signature the `X-FenPOS-Signature` value
 * @param timeoutMs how long the attempt may take
 * @returns the response status
 */
const httpSender: Sender = async (url, body, signature, timeoutMs) => {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-fenpos-signature": signature,
			"user-agent": "FenPOS-Webhook/1",
		},
		body,
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "manual",
	});
	// The status is read; the body never is. Left alone, an unconsumed body holds its connection open
	// under undici until the Response is garbage collected — and this runs on a timer forever, against
	// up to twenty targets a pass, some of which are hostile by construction (a refused address, a
	// receiver that never finishes a response). Cancelling discards it and releases the connection.
	// Its own try/catch: a body that already errored (the connection dropping mid-response, say)
	// rejects on cancel, and that must not overwrite the status this function already has to report.
	try {
		await response.body?.cancel();
	} catch {
		// See above — deliberately ignored.
	}
	return { status: response.status };
};
