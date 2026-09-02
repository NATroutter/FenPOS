import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnstileConfig, verifyTurnstile } from "@/lib/auth/turnstile";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Tests for the bot challenge in front of the sign-in form.
 *
 * Two behaviours carry the weight here, and both are decisions rather than mechanics:
 *
 * **A half-configured challenge is no challenge.** A switch turned on before the keys were filled
 * in would refuse every sign-in on the install, including the one an operator needs to reach
 * Settings and turn it back off. The only way out of that would be editing the database by hand.
 *
 * **An unreachable Cloudflare lets the sign-in through.** The thing being protected is a bot filter
 * standing in front of a password that is still required either way, so a network fault at a third
 * party must not lock every operator out of their own till system. An explicit "no" from Cloudflare
 * is a different matter and still refuses.
 */
describe("the sign-in bot challenge", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	/** Stands in for Cloudflare's verify endpoint. */
	function cloudflareAnswers(body: unknown, { status = 200 }: { status?: number } = {}): void {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(body), { status })),
		);
	}

	/** Puts the install in the state where a challenge is actually run. */
	async function configure(): Promise<void> {
		await setSetting("auth.turnstileEnabled", true);
		await setSetting("auth.turnstileSiteKey", "0xSITEKEY");
		await setSetting("auth.turnstileSecretKey", "0xSECRETKEY");
	}

	describe("turnstileConfig", () => {
		it("is off when nothing is configured", async () => {
			expect(await turnstileConfig()).toEqual({ enabled: false, siteKey: "" });
		});

		it("is on once the switch and both keys are set", async () => {
			await configure();

			expect(await turnstileConfig()).toEqual({ enabled: true, siteKey: "0xSITEKEY" });
		});

		it("stays off when the switch is on but the site key is missing", async () => {
			await setSetting("auth.turnstileEnabled", true);
			await setSetting("auth.turnstileSecretKey", "0xSECRETKEY");

			// Not an error and not a refusal: the install signs in exactly as it did before the switch
			// was touched. See this file's header for why that is the only safe answer.
			expect(await turnstileConfig()).toEqual({ enabled: false, siteKey: "" });
		});

		it("stays off when the switch is on but the secret key is missing", async () => {
			await setSetting("auth.turnstileEnabled", true);
			await setSetting("auth.turnstileSiteKey", "0xSITEKEY");

			expect(await turnstileConfig()).toEqual({ enabled: false, siteKey: "" });
		});

		it("never carries the secret key, which crosses to the browser", async () => {
			await configure();

			const config = await turnstileConfig();

			expect(JSON.stringify(config)).not.toContain("0xSECRETKEY");
		});
	});

	describe("verifyTurnstile", () => {
		it("accepts a token Cloudflare vouches for", async () => {
			await configure();
			cloudflareAnswers({ success: true });

			expect(await verifyTurnstile("a-token", "203.0.113.4")).toEqual({ ok: true });
		});

		it("sends the secret, the token and the caller's address", async () => {
			await configure();
			cloudflareAnswers({ success: true });

			await verifyTurnstile("a-token", "203.0.113.4");

			const [, options] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
			const body = options.body as FormData;
			expect(body.get("secret")).toBe("0xSECRETKEY");
			expect(body.get("response")).toBe("a-token");
			expect(body.get("remoteip")).toBe("203.0.113.4");
		});

		it("refuses a token Cloudflare rejects, keeping its codes for the log", async () => {
			await configure();
			cloudflareAnswers({ success: false, "error-codes": ["timeout-or-duplicate"] });

			expect(await verifyTurnstile("a-spent-token", "203.0.113.4")).toEqual({
				ok: false,
				reason: "rejected",
				codes: ["timeout-or-duplicate"],
			});
		});

		it("refuses a submission that carried no token at all", async () => {
			await configure();
			const called = vi.fn();
			vi.stubGlobal("fetch", called);

			expect(await verifyTurnstile("", "203.0.113.4")).toEqual({ ok: false, reason: "missing" });
			// A direct POST that skipped the widget costs no round trip.
			expect(called).not.toHaveBeenCalled();
		});

		it("lets the sign-in through when Cloudflare cannot be reached", async () => {
			await configure();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("connect ETIMEDOUT");
				}),
			);

			// Fails open, deliberately. The password is still required; see this file's header.
			expect(await verifyTurnstile("a-token", "203.0.113.4")).toEqual({ ok: true });
		});

		it("lets the sign-in through when Cloudflare answers with a server error", async () => {
			await configure();
			cloudflareAnswers({}, { status: 503 });

			// A 5xx is an outage, not a verdict.
			expect(await verifyTurnstile("a-token", "203.0.113.4")).toEqual({ ok: true });
		});

		it("does not fail open when Cloudflare says no", async () => {
			await configure();
			cloudflareAnswers({ success: false, "error-codes": ["invalid-input-response"] });

			// The distinction the two tests above rest on: unreachable is not the same as refused, and
			// collapsing them either way breaks one of the two properties this feature needs.
			expect((await verifyTurnstile("a-forged-token", "203.0.113.4")).ok).toBe(false);
		});

		it("refuses rather than redeeming an empty secret against Cloudflare", async () => {
			await setSetting("auth.turnstileEnabled", true);
			await setSetting("auth.turnstileSiteKey", "0xSITEKEY");
			const called = vi.fn();
			vi.stubGlobal("fetch", called);

			// Unreachable through the sign-in action, which asks `turnstileConfig` first. Guarded so a
			// future caller that skipped that check cannot have an empty secret quietly accepted.
			const verdict = await verifyTurnstile("a-token", "203.0.113.4");

			expect(verdict.ok).toBe(false);
			expect(called).not.toHaveBeenCalled();
		});
	});
});
