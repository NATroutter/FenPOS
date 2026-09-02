import "server-only";
import { logger } from "@/lib/logger";
import { booleanSetting, secretSetting, stringSetting } from "@/lib/settings/settings-service";

/**
 * Cloudflare Turnstile, in front of the password.
 *
 * **What this is and is not.** Turnstile is a bot filter, not a credential check. Solving it proves
 * nothing about who the caller is, and failing it proves nothing about whether they hold a password.
 * It exists to make the sign-in form expensive to hammer from a script — the throttle in
 * `rate-limit.ts` already bounds attempts per address, and this bounds the far cheaper attack of
 * attempts from many addresses. Everything downstream of it still runs unchanged.
 *
 * That framing decides every judgement call in this file, and in particular the one below about what
 * to do when Cloudflare cannot be reached.
 */

/** Where a token is redeemed. Cloudflare's documented endpoint; there is no other. */
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * How long to wait for Cloudflare before giving up on a sign-in.
 *
 * Short, because a person is watching a spinner while this runs and the whole point of the widget is
 * that it has already done its work by the time the form is submitted — redemption is a lookup.
 * Anything slower than this is an outage rather than a slow answer, and {@link verifyTurnstile}
 * treats it as one.
 */
const VERIFY_TIMEOUT_MS = 5_000;

/** The field name Cloudflare's widget posts its token under. Fixed by the widget, not by us. */
export const TURNSTILE_FIELD = "cf-turnstile-response";

/**
 * What the sign-in page needs in order to render the widget.
 *
 * Only the public half. The secret is never part of this shape, because this crosses to the browser.
 */
export interface TurnstileConfig {
	/** Whether to render a challenge at all. */
	enabled: boolean;
	/** The site key to render it with. Empty only when `enabled` is false. */
	siteKey: string;
}

/**
 * Whether a challenge is switched on and actually configured.
 *
 * **Both keys are required for `enabled` to come back true, and that is a lockout guard rather than
 * tidiness.** A switch turned on before the keys were filled in would refuse every sign-in on the
 * install — including the sign-in an operator needs in order to reach Settings and turn it back off.
 * The recovery for that is editing the database by hand. Treating a half-configured challenge as no
 * challenge costs the install nothing it had, since a widget with no site key renders nothing to
 * solve anyway.
 *
 * @returns what the sign-in page should render
 */
export async function turnstileConfig(): Promise<TurnstileConfig> {
	const enabled = await booleanSetting("auth.turnstileEnabled");
	if (!enabled) {
		return { enabled: false, siteKey: "" };
	}

	const siteKey = (await stringSetting("auth.turnstileSiteKey")).trim();
	const secret = (await secretSetting("auth.turnstileSecretKey")).trim();
	if (siteKey === "" || secret === "") {
		logger.warn("The bot challenge is switched on but not configured, so sign-in is proceeding without it", {
			siteKey: siteKey === "" ? "missing" : "set",
			secretKey: secret === "" ? "missing" : "set",
		});
		return { enabled: false, siteKey: "" };
	}

	return { enabled: true, siteKey };
}

/** Why a challenge was not accepted, or that it was. */
export type TurnstileVerdict =
	| { ok: true }
	/** Cloudflare answered, and the answer was no. `codes` are its own, for the server log. */
	| { ok: false; reason: "rejected"; codes: string[] }
	/** Nothing was submitted. A direct POST that skipped the widget, or a widget that never loaded. */
	| { ok: false; reason: "missing" };

/**
 * Redeems a Turnstile token with Cloudflare.
 *
 * **A token is single-use and short-lived.** Cloudflare refuses a second redemption of the same
 * one, which is why the form must reset its widget after every refused submission — a retry that
 * reposted the old token would fail for a reason the operator could do nothing about. See
 * `login-form.tsx`.
 *
 * **An unreachable Cloudflare lets the sign-in through, and that is deliberate.** The alternative
 * is that a network fault at a third party locks every operator out of their own till system, with
 * no way in short of a database edit — and the thing it would be protecting is a bot filter standing
 * in front of a password that is still required either way. So a timeout, a DNS failure or a 5xx is
 * logged loudly and treated as no challenge; only an actual "no" from Cloudflare refuses. An
 * explicit refusal is the case this exists for and it is not weakened.
 *
 * The caller's address is passed along because Cloudflare uses it in its own scoring. It is the
 * address `getClientAddress` resolved, which behind a proxy is only as trustworthy as that proxy —
 * Cloudflare treats it as a hint, and so should any reading of the result.
 *
 * @param token whatever the form posted under {@link TURNSTILE_FIELD}
 * @param address the caller's address, as a hint for Cloudflare's scoring
 * @returns whether the challenge stands
 */
export async function verifyTurnstile(token: string, address: string): Promise<TurnstileVerdict> {
	if (token.trim() === "") {
		return { ok: false, reason: "missing" };
	}

	const secret = (await secretSetting("auth.turnstileSecretKey")).trim();
	if (secret === "") {
		// Unreachable through the sign-in action, which asks `turnstileConfig` first and skips the
		// challenge entirely when the secret is missing. Guarded anyway: a caller that reached here
		// without that check must not have an empty secret quietly accepted by Cloudflare.
		logger.error("A Turnstile token was submitted with no secret key configured to redeem it against");
		return { ok: false, reason: "rejected", codes: ["secret-not-configured"] };
	}

	const body = new FormData();
	body.set("secret", secret);
	body.set("response", token);
	if (address !== "") {
		body.set("remoteip", address);
	}

	let payload: { success?: unknown; "error-codes"?: unknown };
	try {
		const response = await fetch(VERIFY_URL, {
			method: "POST",
			body,
			signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
			// This is a credential redemption on the operator's behalf; a cached answer would be both
			// wrong and a token replay.
			cache: "no-store",
		});
		if (!response.ok) {
			// A 5xx from Cloudflare is an outage, not a verdict. Same treatment as a timeout.
			logger.warn("Turnstile verification is unavailable, so sign-in is proceeding without it", {
				status: response.status,
			});
			return { ok: true };
		}
		payload = (await response.json()) as typeof payload;
	} catch (error) {
		logger.warn("Turnstile could not be reached, so sign-in is proceeding without it", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return { ok: true };
	}

	if (payload.success === true) {
		return { ok: true };
	}

	// Cloudflare's own codes, kept for the log. They name real causes an operator can act on —
	// `invalid-input-secret` is a wrong secret key, `timeout-or-duplicate` is a token reused or gone
	// stale — and none of them is shown to whoever is signing in.
	const codes = Array.isArray(payload["error-codes"]) ? payload["error-codes"].map(String) : [];
	return { ok: false, reason: "rejected", codes };
}
