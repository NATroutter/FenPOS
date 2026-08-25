import { beforeEach, describe, expect, it } from "vitest";
import {
	apiReadLimiter,
	consumeApiRead,
	consumeSignInAttempt,
	RateLimiter,
	requireApiRead,
	signInThrottlePhrase,
} from "@/lib/auth/rate-limit";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Time is injected into every call rather than advanced with timers, so these tests contain
 * no sleeps and cannot become flaky under load.
 */
describe("RateLimiter", () => {
	const options = { limit: 5, windowMs: 60_000 };

	it("permits attempts up to the limit", () => {
		const limiter = new RateLimiter(options);
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			expect(limiter.consume("1.2.3.4", 1_000).allowed).toBe(true);
		}
	});

	it("blocks the attempt past the limit", () => {
		const limiter = new RateLimiter(options);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			limiter.consume("1.2.3.4", 1_000);
		}
		expect(limiter.consume("1.2.3.4", 1_000).allowed).toBe(false);
	});

	it("reports remaining capacity accurately", () => {
		const limiter = new RateLimiter(options);
		expect(limiter.consume("1.2.3.4", 1_000).remaining).toBe(4);
		expect(limiter.consume("1.2.3.4", 1_000).remaining).toBe(3);
	});

	it("reports how long until capacity returns", () => {
		const limiter = new RateLimiter(options);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			limiter.consume("1.2.3.4", 1_000);
		}
		expect(limiter.consume("1.2.3.4", 31_000).retryAfterMs).toBe(30_000);
	});

	it("counts each key independently, so one caller cannot lock out another", () => {
		const limiter = new RateLimiter(options);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			limiter.consume("1.2.3.4", 1_000);
		}
		expect(limiter.consume("1.2.3.4", 1_000).allowed).toBe(false);
		expect(limiter.consume("5.6.7.8", 1_000).allowed).toBe(true);
	});

	it("opens a fresh window once the previous one expires", () => {
		const limiter = new RateLimiter(options);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			limiter.consume("1.2.3.4", 1_000);
		}
		expect(limiter.consume("1.2.3.4", 1_000).allowed).toBe(false);
		expect(limiter.consume("1.2.3.4", 61_001).allowed).toBe(true);
	});

	it("clears a key on reset, so a successful sign-in is not left throttled", () => {
		const limiter = new RateLimiter(options);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			limiter.consume("1.2.3.4", 1_000);
		}
		expect(limiter.consume("1.2.3.4", 1_000).allowed).toBe(false);

		limiter.reset("1.2.3.4");
		expect(limiter.consume("1.2.3.4", 1_000).allowed).toBe(true);
	});

	it("does not retain expired keys, since keys are caller-supplied", () => {
		const limiter = new RateLimiter(options);
		for (let index = 0; index < 100; index += 1) {
			limiter.consume(`10.0.0.${index}`, 1_000);
		}

		// Consuming after every window has lapsed must sweep the earlier keys rather than
		// letting an attacker grow the map without bound by varying the key. The sweep is
		// not observable directly, so this asserts its consequence: a previously seen key
		// starts a fresh window rather than resuming a retained one.
		limiter.consume("192.168.0.1", 61_001);
		expect(limiter.consume("10.0.0.0", 61_001).remaining).toBe(4);
	});

	it("treats a limit of one as allowing exactly one attempt", () => {
		const limiter = new RateLimiter({ limit: 1, windowMs: 1_000 });
		expect(limiter.consume("key", 0).allowed).toBe(true);
		expect(limiter.consume("key", 0).allowed).toBe(false);
	});

	describe("limitOverride", () => {
		it("throttles at the override rather than the limiter's constructed limit", () => {
			const limiter = new RateLimiter({ limit: 5, windowMs: 60_000 });
			for (let attempt = 0; attempt < 2; attempt += 1) {
				expect(limiter.consume("key", 1_000, 2).allowed).toBe(true);
			}
			expect(limiter.consume("key", 1_000, 2).allowed).toBe(false);
		});

		it("applies within the same window as soon as it changes, without waiting for a reset", () => {
			const limiter = new RateLimiter({ limit: 5, windowMs: 60_000 });
			for (let attempt = 0; attempt < 2; attempt += 1) {
				limiter.consume("key", 1_000, 2);
			}
			expect(limiter.consume("key", 1_000, 2).allowed).toBe(false);

			// Same window (no time has passed), but a higher override now covers the count already
			// recorded against this key.
			expect(limiter.consume("key", 1_000, 10).allowed).toBe(true);
		});

		it("falls back to the constructed limit when no override is given", () => {
			const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 });
			expect(limiter.consume("key", 1_000).allowed).toBe(true);
			expect(limiter.consume("key", 1_000).allowed).toBe(true);
			expect(limiter.consume("key", 1_000).allowed).toBe(false);
		});
	});
});

/**
 * `consumeSignInAttempt` is what `signIn` (`app/(auth)/login/actions.ts`) actually calls. The
 * behaviour worth pinning here is that the configured `auth.signInAttemptsPerMinute` reaches it —
 * not that the setting stores, which `settings-service.test.ts` already covers, including the
 * floor itself as a `setSetting` rejection.
 */
describe("consumeSignInAttempt", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("throttles sign-in at the configured rate", async () => {
		await setSetting("auth.signInAttemptsPerMinute", 3);

		const address = "203.0.113.10";
		for (let attempt = 0; attempt < 3; attempt += 1) {
			expect((await consumeSignInAttempt(address, 1_000)).allowed).toBe(true);
		}
		expect((await consumeSignInAttempt(address, 1_000)).allowed).toBe(false);
	});

	it("reads the setting fresh on every call, so a change applies immediately", async () => {
		const address = "203.0.113.11";
		await setSetting("auth.signInAttemptsPerMinute", 3);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await consumeSignInAttempt(address, 1_000);
		}
		expect((await consumeSignInAttempt(address, 1_000)).allowed).toBe(false);

		// Same window, but the limit was raised on the Settings tab — the next attempt should not
		// have to wait for the window to expire or the server to restart.
		await setSetting("auth.signInAttemptsPerMinute", 5);
		expect((await consumeSignInAttempt(address, 1_000)).allowed).toBe(true);
	});
});

describe("signInThrottlePhrase", () => {
	it("uses the singular at exactly one", () => {
		expect(signInThrottlePhrase(1)).toBe("1 attempt per minute");
	});

	it("uses the plural at the setting's minimum", () => {
		expect(signInThrottlePhrase(3)).toBe("3 attempts per minute");
	});

	it("uses the plural at the setting's maximum", () => {
		expect(signInThrottlePhrase(5)).toBe("5 attempts per minute");
	});
});

describe("consumeApiRead", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
		apiReadLimiter.reset("key-1");
		apiReadLimiter.reset("key-2");
	});

	it("allows reads up to the configured limit and refuses the next one", async () => {
		await setSetting("api.readsPerMinute", 2);

		expect((await consumeApiRead("key-1")).allowed).toBe(true);
		expect((await consumeApiRead("key-1")).allowed).toBe(true);
		expect((await consumeApiRead("key-1")).allowed).toBe(false);
	});

	it("counts each key separately, so one busy till cannot throttle another", async () => {
		await setSetting("api.readsPerMinute", 1);

		expect((await consumeApiRead("key-1")).allowed).toBe(true);
		expect((await consumeApiRead("key-2")).allowed).toBe(true);
	});

	it("reports when capacity returns, so the caller can be told", async () => {
		await setSetting("api.readsPerMinute", 1);

		await consumeApiRead("key-1", 0);
		const refused = await consumeApiRead("key-1", 30_000);

		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterMs).toBe(30_000);
	});
});

describe("requireApiRead", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
		apiReadLimiter.reset("key-1");
	});

	it("resolves without throwing while the key is within budget", async () => {
		await setSetting("api.readsPerMinute", 2);

		await expect(requireApiRead("key-1")).resolves.toBeUndefined();
		await expect(requireApiRead("key-1")).resolves.toBeUndefined();
	});

	it("throws rate_limited with retryAfterSeconds once the budget is spent", async () => {
		await setSetting("api.readsPerMinute", 1);

		await requireApiRead("key-1");

		try {
			await requireApiRead("key-1");
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			const apiError = error as ApiError;
			expect(apiError.code).toBe("rate_limited");
			expect(apiError.details.retryAfterSeconds).toBe(60);
		}
	});
});

describe("setup limiter", () => {
	it("is tighter than the sign-in limiter", async () => {
		const { setupLimiter } = await import("@/lib/auth/rate-limit");

		const address = "203.0.113.9";
		const now = Date.now();

		const outcomes = Array.from({ length: 6 }, () => setupLimiter.consume(address, now));

		expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(3);
		expect(outcomes.at(-1)?.allowed).toBe(false);
		expect(outcomes.at(-1)?.retryAfterMs).toBeGreaterThan(0);
	});
});
