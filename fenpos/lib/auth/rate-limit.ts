import { ApiError } from "@/lib/errors";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * Attempt limiting for credential endpoints.
 *
 * Two endpoints depend on this rather than treating it as a nicety. Sign-in is throttled so
 * the administrator password cannot be ground down online, and agent pairing is throttled
 * because the pairing code's entropy budget assumes guessing is slow — without a limiter,
 * the code's short lifetime is the only bound on how many guesses an attacker gets.
 *
 * State is held in this process. That is correct for the supported deployment — one
 * self-hosted server — but it means limits are per-instance and reset on restart. Neither
 * matters here: an attacker who can restart the server has already won, and running
 * multiple instances would need a shared store. The interface is deliberately small so that
 * swapping in such a store later touches this file only.
 */

/** Outcome of consuming an attempt. */
export interface RateLimitResult {
	/** Whether the caller may proceed. */
	allowed: boolean;
	/** Attempts still available in the current window. */
	remaining: number;
	/** Milliseconds until the window resets. Zero when the limiter is not engaged. */
	retryAfterMs: number;
}

/** Configuration for one limiter. */
export interface RateLimitOptions {
	/** Attempts permitted within one window. */
	limit: number;
	/** Window length in milliseconds. */
	windowMs: number;
}

interface Window {
	count: number;
	/** Epoch milliseconds at which this window expires. */
	resetAt: number;
}

/**
 * A fixed-window attempt limiter keyed by an arbitrary string.
 *
 * A fixed window is used rather than a sliding log because the failure mode it is criticised
 * for — up to twice the limit across a window boundary — is irrelevant at these numbers,
 * while its constant memory per key is not: keys here are caller-supplied (an IP address),
 * so an unbounded per-key structure would itself be an attack surface.
 */
export class RateLimiter {
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #windows = new Map<string, Window>();

	/**
	 * @param options attempts permitted, and the window they are counted over
	 */
	constructor(options: RateLimitOptions) {
		this.#limit = options.limit;
		this.#windowMs = options.windowMs;
	}

	/**
	 * Records an attempt against a key.
	 *
	 * @param key the caller identity to limit on, typically a client IP address
	 * @param now current time; injectable so tests need no sleeps
	 * @param limitOverride replaces the limiter's own constructed limit for this call only,
	 *   without changing it for any other key or any later call. Exists so a limit read from a
	 *   stored setting — necessarily read asynchronously — can still govern a plain synchronous
	 *   call here: the caller awaits the setting first and passes the result in, rather than this
	 *   class awaiting anything itself. See `consumeSignInAttempt` for the caller that does this.
	 * @returns whether the attempt is permitted, and when capacity returns
	 */
	consume(key: string, now: number = Date.now(), limitOverride?: number): RateLimitResult {
		const limit = limitOverride ?? this.#limit;
		this.#evictExpired(now);

		const existing = this.#windows.get(key);
		if (!existing || existing.resetAt <= now) {
			this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
			return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
		}

		if (existing.count >= limit) {
			return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
		}

		existing.count += 1;
		return {
			allowed: true,
			remaining: limit - existing.count,
			retryAfterMs: 0,
		};
	}

	/**
	 * Clears a key's window.
	 *
	 * Called after a successful sign-in so that a legitimate operator who mistyped a few
	 * times is not left throttled for the rest of the window.
	 *
	 * @param key the caller identity to reset
	 */
	reset(key: string): void {
		this.#windows.delete(key);
	}

	/**
	 * Milliseconds until `key`'s current window resets, or zero if it has none right now.
	 * Read-only — does not advance state. Lets a caller that already consumed once against a
	 * provisional limit compute an accurate `retryAfterMs` if it then rejects that same attempt
	 * against a stricter limit, without consuming a second time. See `consumeSignInAttempt`.
	 *
	 * @param key the caller identity to inspect
	 * @param now current time; injectable so tests need no sleeps
	 */
	peekRetryAfterMs(key: string, now: number = Date.now()): number {
		const existing = this.#windows.get(key);
		if (!existing || existing.resetAt <= now) {
			return 0;
		}
		return existing.resetAt - now;
	}

	/**
	 * Drops windows that have expired.
	 *
	 * Runs on every call rather than on a timer, so the limiter owns no background work and
	 * needs no shutdown. Without this, keys from one-off callers would accumulate for the
	 * lifetime of the process.
	 *
	 * @param now current time
	 */
	#evictExpired(now: number): void {
		for (const [key, window] of this.#windows) {
			if (window.resetAt <= now) {
				this.#windows.delete(key);
			}
		}
	}
}

/**
 * `auth.signInAttemptsPerMinute`'s declared `max` (settings-service.ts) — the setting can only
 * ever be configured at or below this. Used both as `signInLimiter`'s constructed default and as
 * the provisional ceiling {@link consumeSignInAttempt} gates on before it knows the configured
 * value.
 */
const SIGN_IN_BUILT_IN_CEILING = 5;

/**
 * Sign-in limiter.
 *
 * The constructed limit here is only the fallback a caller sees if it never supplies an
 * override — every production call goes through {@link consumeSignInAttempt}, which reads
 * `auth.signInAttemptsPerMinute` and passes it in, so this constant matches that setting's own
 * `fallback` (and, not incidentally, its `max`) rather than mattering on its own.
 */
export const signInLimiter = new RateLimiter({ limit: SIGN_IN_BUILT_IN_CEILING, windowMs: 60_000 });

/**
 * Consumes a sign-in attempt at the currently configured throttle.
 *
 * Consumes against {@link SIGN_IN_BUILT_IN_CEILING} first, synchronously, before reading
 * `auth.signInAttemptsPerMinute` — the inverse of the naive order (read the setting, then
 * consume) would run a full `listSettings()` query on every unauthenticated sign-in attempt,
 * ahead of any throttling. `app/api/pair/route.ts` establishes the same ordering for its own
 * limiter, for the same reason ("Do not 'optimise' this back."); this one cannot consume first
 * *unconditionally* the way pairing does, because the limit itself is a setting, not a constant —
 * but because the setting can never be configured above the built-in ceiling, a caller already
 * over that ceiling is over the configured limit too, whatever it is, and is rejected here without
 * ever touching the database. Only a caller still within the ceiling causes the settings read, and
 * only when the configured limit is tighter than the ceiling does this then re-evaluate the same
 * attempt against it — using `remaining` from the first consume to recover the count, so the
 * attempt is never counted twice.
 *
 * Reads `auth.signInAttemptsPerMinute` fresh on every call rather than once at startup, so a
 * limit tightened on the Settings tab applies to the very next attempt rather than waiting for a
 * restart or for the current window to expire. `signIn` (`app/(auth)/login/actions.ts`) is the
 * only production caller; exported under its own name so the setting's effect on throttling can
 * be verified directly, rather than only asserting that the setting stores.
 *
 * @param address the caller's client address, used as the limiter's key
 * @param now current time; injectable so tests need no sleeps
 * @returns whether the attempt is permitted, and when capacity returns
 */
export async function consumeSignInAttempt(address: string, now: number = Date.now()): Promise<RateLimitResult> {
	const provisional = signInLimiter.consume(address, now);
	if (!provisional.allowed) {
		return provisional;
	}

	const limit = await integerSetting("auth.signInAttemptsPerMinute");
	if (limit >= SIGN_IN_BUILT_IN_CEILING) {
		return provisional;
	}

	const count = SIGN_IN_BUILT_IN_CEILING - provisional.remaining;
	if (count <= limit) {
		return { allowed: true, remaining: limit - count, retryAfterMs: 0 };
	}
	return { allowed: false, remaining: 0, retryAfterMs: signInLimiter.peekRetryAfterMs(address, now) };
}

/**
 * Phrases the configured sign-in throttle for the note on the sign-in page footer, pluralising
 * "attempt" only where the count requires it.
 *
 * Extracted because this project has broken exactly this kind of sentence at a boundary three
 * times already — "0 MB", "1 distinct URLs", "1 hours" — and a hardcoded "five attempts per
 * minute" was itself already one boundary bug waiting to happen the day this setting became
 * configurable.
 *
 * @param limit the configured `auth.signInAttemptsPerMinute`
 * @returns e.g. "5 attempts per minute" or, at a limit of one, "1 attempt per minute"
 */
export function signInThrottlePhrase(limit: number): string {
	return `${limit} ${limit === 1 ? "attempt" : "attempts"} per minute`;
}

/**
 * Pairing limiter, keyed by client address.
 *
 * Tighter than sign-in because a pairing attempt is a guess at a code rather than at a
 * password an operator might genuinely mistype. Deliberately not a setting: the pairing code's
 * entropy budget assumes guessing is slow, and loosening this limit would weaken that assumption
 * invisibly — unlike the sign-in throttle, there is no floor here that is safe to expose.
 */
export const pairingLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });

/**
 * Setup key limiter, keyed by client address.
 *
 * Tighter than sign-in and tighter than pairing, because a wrong guess here is never an operator
 * mistyping a password they know — the key is copied off a terminal, so a legitimate attempt is
 * a paste. What is on the other side of a correct guess is total control of an unclaimed install
 * and, through it, of the printers it will later drive.
 *
 * Deliberately not a setting, for the same reason `pairingLimiter` is not: the key's entropy
 * budget assumes guessing is slow, and there is no floor here that would be safe to expose.
 */
export const setupLimiter = new RateLimiter({ limit: 3, windowMs: 60_000 });

/**
 * The ceiling `api.readsPerMinute` may be configured to, and this limiter's constructed default.
 *
 * Matches the setting's declared `max`. Unlike the sign-in limiter, no provisional consume against
 * this ceiling is needed: the caller here is already authenticated, so reading the setting first
 * costs a query on a request that has done a key lookup anyway.
 */
const API_READ_CEILING = 10_000;

/**
 * Read throttle for API key callers, keyed by key id rather than by address.
 *
 * Keyed by the credential and not the caller's IP on purpose. Several tills behind one shop's NAT
 * share an address and must not share a budget, and a key used from two addresses is one integrator
 * either way.
 */
export const apiReadLimiter = new RateLimiter({ limit: API_READ_CEILING, windowMs: 60_000 });

/**
 * Consumes one read against a key's current budget.
 *
 * Reads `api.readsPerMinute` fresh on each call, so a limit tightened on the Settings tab governs
 * the next request rather than waiting for a restart.
 *
 * @param keyId the authenticated key's id, used as the limiter's key
 * @param now current time; injectable so tests need no sleeps
 * @returns whether the read is permitted, and when capacity returns
 */
export async function consumeApiRead(keyId: string, now: number = Date.now()): Promise<RateLimitResult> {
	const limit = await integerSetting("api.readsPerMinute");
	return apiReadLimiter.consume(keyId, now, limit);
}

/**
 * Consumes one read against a key's budget, throwing the API's standard refusal when it is spent.
 *
 * Every read endpoint behind `api.readsPerMinute` used to carry its own three-line "consume, check
 * `allowed`, raise `rate_limited`" block. That was tolerable at three call sites and stops being so
 * once the endpoint count grows, so the block moves here once and each route calls this instead.
 * `consumeApiRead` stays exported and unchanged beside it — it is the primitive its own tests
 * exercise, and it is what this function is built on rather than a copy of its logic.
 *
 * @param keyId the authenticated key's id, used as the limiter's key
 * @throws ApiError `rate_limited` when the key is over budget, carrying `retryAfterSeconds`
 */
export async function requireApiRead(keyId: string): Promise<void> {
	const result = await consumeApiRead(keyId);
	if (!result.allowed) {
		throw new ApiError("rate_limited", "Too many requests from this key. Try again shortly.", {
			retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
		});
	}
}
