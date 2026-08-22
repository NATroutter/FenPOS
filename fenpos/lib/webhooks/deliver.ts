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
 * one fires. Nothing here holds a lock across a whole pass — instead, each delivery is claimed
 * individually with a compare-and-swap on `attempts` (`UPDATE ... WHERE id = ? AND attempts = ?`)
 * before it is touched. Two passes that both read the same row before either claims it will both try
 * to claim it, but only one `UPDATE` can match the row's still-unclaimed `attempts` value — the
 * other affects zero rows and that pass skips the delivery, leaving it for whichever pass actually
 * won. This is the same shape SQL job queues use for "claim one row, mine alone" without a
 * `SELECT ... FOR UPDATE` this schema's driver does not offer, and it costs nothing extra: `attempts`
 * already has to be incremented per attempt, so the claim *is* that increment, done as the atomic
 * step that decides who owns the row rather than as a fact recorded after the fact.
 *
 * **One hostile target must not stall the rest of the batch.** A batch is sent concurrently
 * ({@link Promise.all} over {@link processDelivery}), not one delivery after another — each attempt
 * is already bounded by `webhooks.timeoutMs` on its own, so running the batch concurrently bounds
 * the whole pass by the slowest single attempt instead of by their sum. A delivery that throws
 * something unexpected (not a rejected `send`, which is already handled, but e.g. a database error)
 * is caught inside {@link processDelivery} rather than left to reject its place in the `Promise.all`
 * — this function runs on a timer with nobody to catch it, so one bad row must not cost every other
 * delivery in the same pass.
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

		// The claim: only one of however many overlapping passes have read this row can match its
		// still-unclaimed `attempts` value, so only one can win it. See the module comment.
		const claim = await prisma.webhookDelivery.updateMany({
			where: { id: delivery.id, status: "PENDING", attempts: delivery.attempts },
			data: { attempts },
		});
		if (claim.count === 0) {
			return false;
		}

		const refusal = await targetRefusal(delivery.webhook.url, settings.allowPlainHttp);
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
 * @returns the reason to refuse, or null when the target is acceptable
 */
async function targetRefusal(url: string, allowPlainHttp: boolean): Promise<string | null> {
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
	const resolved = await resolveHostname(hostname);
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
 * @param hostname the target's hostname, brackets already stripped
 * @returns every address it resolves to, or null when it does not resolve at all
 */
async function resolveHostname(hostname: string): Promise<string[] | null> {
	if (isIP(hostname) !== 0) {
		return [hostname];
	}
	try {
		const { lookup } = await import("node:dns/promises");
		const entries = await lookup(hostname, { all: true });
		return entries.map((entry) => entry.address);
	} catch {
		return null;
	}
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
	return { status: response.status };
};
