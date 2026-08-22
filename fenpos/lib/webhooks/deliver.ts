import "server-only";
import { isIP } from "node:net";
import { prisma } from "@/lib/db";
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
 * The residual window is a DNS answer that changes between this check and the connection, exploitable
 * only by someone who can already both edit an operator's webhook URL and control that DNS.
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

/** Settings read once per pass and threaded through {@link processDelivery} for every delivery in it. */
interface DeliverySettings {
	timeoutMs: number;
	maxAttempts: number;
	backoffSeconds: number;
	allowPlainHttp: boolean;
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
			where: { status: "PENDING", nextAttemptAt: { lte: now } },
			orderBy: { nextAttemptAt: "asc" },
			take: BATCH,
			include: { webhook: { select: { url: true, secret: true, enabled: true } } },
		});

		const [timeoutMs, maxAttempts, backoffSeconds, allowPlainHttp] = await Promise.all([
			integerSetting("webhooks.timeoutMs"),
			integerSetting("webhooks.maxAttempts"),
			integerSetting("webhooks.retryBackoffSeconds"),
			booleanSetting("webhooks.allowPlainHttp"),
		]);
		const settings: DeliverySettings = { timeoutMs, maxAttempts, backoffSeconds, allowPlainHttp };

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
			return false;
		}

		const attempts = delivery.attempts + 1;

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

		const refusal = await targetRefusal(delivery.webhook.url, settings.allowPlainHttp, settings.timeoutMs);
		if (refusal !== null) {
			// Not retried. The target is wrong rather than unavailable, and no number of attempts
			// will make an address this server must not reach into one it may.
			await settleFailed(delivery.id, attempts, refusal);
			logger.warn("Refused to deliver a webhook", { deliveryId: delivery.id, reason: refusal });
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
				await prisma.webhookDelivery.update({
					where: { id: delivery.id },
					data: { status: "DELIVERED", attempts, deliveredAt: now, lastError: null },
				});
				return true;
			}

			const permanent = status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.includes(status);
			await recordFailure(delivery.id, attempts, `The receiver answered ${status}.`, {
				now,
				maxAttempts: settings.maxAttempts,
				backoffSeconds: settings.backoffSeconds,
				permanent,
			});
		} catch (error) {
			await recordFailure(delivery.id, attempts, String(error instanceof Error ? error.message : error), {
				now,
				maxAttempts: settings.maxAttempts,
				backoffSeconds: settings.backoffSeconds,
				permanent: false,
			});
		}
		return true;
	} catch (error) {
		// See the module comment: this pass must survive one delivery misbehaving in a way that is
		// not "the target answered badly" — the two ordinary failure paths above already return
		// normally. Left PENDING at whatever `nextAttemptAt` it already had, so the next pass simply
		// tries it again rather than this one being the delivery's last recorded attempt.
		logger.error("Unexpected error delivering a webhook", error, { deliveryId: delivery.id });
		return false;
	}
}

/**
 * Why this target must not be delivered to, if it must not be.
 *
 * @param url the registered target
 * @param allowPlainHttp whether the install permits http
 * @param timeoutMs how long address resolution may take — see {@link resolveHostname}
 * @returns the reason to refuse, or null when the target is acceptable
 */
async function targetRefusal(url: string, allowPlainHttp: boolean, timeoutMs: number): Promise<string | null> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return "the URL could not be parsed";
	}

	if (target.protocol !== "https:" && target.protocol !== "http:") {
		return `${target.protocol} is not a scheme this server delivers over`;
	}
	if (target.protocol === "http:" && !allowPlainHttp) {
		return "this install only delivers webhooks over https";
	}

	const hostname = target.hostname.replace(/^\[|\]$/g, "");
	if (hostname === "") {
		return "the URL names no host";
	}

	// A literal address needs no resolver; a hostname does. Both end at the same judgement.
	const resolved = await resolveHostname(hostname, timeoutMs);
	if (resolved === null) {
		return `the hostname ${hostname} has no address`;
	}
	if (resolved.length === 0) {
		return `the hostname ${hostname} did not resolve to any address`;
	}

	for (const address of resolved) {
		const why = blockedReason(address);
		if (why !== null) {
			return `${hostname} resolves to ${address}, which is ${why}`;
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
 * `webhooks.timeoutMs` ceiling this module otherwise holds every attempt to. Raced against a timer so
 * that "DNS is slow" fails exactly like "DNS has no answer" — both become the same `null`, which
 * {@link targetRefusal} turns into the same "has no address" refusal, so there is one failure path
 * here rather than two. What this cannot do is cancel the underlying lookup: `dns.lookup` offers no
 * abort signal, so a lookup that loses the race keeps running in Node's resolver thread pool until it
 * finishes on its own — this only bounds how long the delivery *waits* for an answer, not how long
 * the lookup itself runs.
 *
 * @param hostname the target's hostname, brackets already stripped
 * @param timeoutMs how long to wait for an answer before treating this as unresolvable
 * @returns every address it resolves to, or null when it does not resolve (or resolve in time)
 */
async function resolveHostname(hostname: string, timeoutMs: number): Promise<string[] | null> {
	if (isIP(hostname) !== 0) {
		return [hostname];
	}
	try {
		const { lookup } = await import("node:dns/promises");
		const entries = await Promise.race([lookup(hostname, { all: true }), rejectAfter(timeoutMs)]);
		return entries.map((entry) => entry.address);
	} catch {
		return null;
	}
}

/**
 * Rejects after `ms`, for racing against an operation that carries no timeout of its own.
 *
 * The timer is unref'd so a lookup that is still pending when the process would otherwise exit does
 * not hold it open on its own.
 *
 * @param ms how long to wait before rejecting
 * @returns a promise that never resolves, only rejects
 */
function rejectAfter(ms: number): Promise<never> {
	return new Promise((_resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		timer.unref?.();
	});
}

/**
 * Records a failed attempt, retrying or giving up.
 *
 * @param id the delivery
 * @param attempts the attempt just made, counted from one
 * @param reason what went wrong, stored for an operator to read
 * @param options the clock, the ceiling, the backoff, and whether this failure is worth retrying
 */
async function recordFailure(
	id: string,
	attempts: number,
	reason: string,
	options: { now: Date; maxAttempts: number; backoffSeconds: number; permanent: boolean },
): Promise<void> {
	if (options.permanent || attempts >= options.maxAttempts) {
		await settleFailed(id, attempts, reason);
		return;
	}

	// Doubling from the configured base: 10s, 20s, 40s… A receiver that is down for a few minutes is
	// not hammered while it recovers, and one that is down for an hour stops being retried at all.
	// Capped at MAX_BACKOFF_SECONDS — see its own comment for why the doubling alone is not enough.
	const waitSeconds = Math.min(options.backoffSeconds * 2 ** (attempts - 1), MAX_BACKOFF_SECONDS);

	await prisma.webhookDelivery.update({
		where: { id },
		data: {
			attempts,
			lastError: reason,
			nextAttemptAt: new Date(options.now.getTime() + waitSeconds * 1000),
		},
	});
}

/**
 * Marks a delivery as given up on.
 *
 * @param id the delivery
 * @param attempts the attempt count to record
 * @param reason what went wrong
 */
async function settleFailed(id: string, attempts: number, reason: string): Promise<void> {
	await prisma.webhookDelivery.update({
		where: { id },
		data: { status: "FAILED", attempts, lastError: reason },
	});
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
