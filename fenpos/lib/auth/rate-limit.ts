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
	 * @returns whether the attempt is permitted, and when capacity returns
	 */
	consume(key: string, now: number = Date.now()): RateLimitResult {
		this.#evictExpired(now);

		const existing = this.#windows.get(key);
		if (!existing || existing.resetAt <= now) {
			this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
			return { allowed: true, remaining: this.#limit - 1, retryAfterMs: 0 };
		}

		if (existing.count >= this.#limit) {
			return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
		}

		existing.count += 1;
		return {
			allowed: true,
			remaining: this.#limit - existing.count,
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

/** Sign-in limiter: five attempts per minute, as stated in the admin panel. */
export const signInLimiter = new RateLimiter({ limit: 5, windowMs: 60_000 });

/**
 * Pairing limiter, keyed by client address.
 *
 * Tighter than sign-in because a pairing attempt is a guess at a code rather than at a
 * password an operator might genuinely mistype.
 */
export const pairingLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });
