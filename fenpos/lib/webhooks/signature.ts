import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Proving a delivery came from this install, and that it is recent.
 *
 * The scheme is deliberately the conventional one — `t=<unix>,v1=<hex>` over `${t}.${body}` — so an
 * integrator can verify it with whatever library they already have rather than reading this file.
 *
 * **The timestamp is signed, not merely sent.** A signature over the body alone is valid forever: a
 * delivery captured once could be replayed a week later and the receiver, checking only the digest,
 * would act on a stale event. Signing the moment means a replay must either carry its original
 * timestamp — which a receiver rejects as too old — or alter it, which breaks the digest.
 */

/** How far a delivery's timestamp may be from the receiver's clock, by default, in seconds. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Generates a subscription secret.
 *
 * Prefixed so that a secret found in a receiver's configuration is recognisable for what it is —
 * the same reason API keys carry a prefix.
 *
 * @returns a new secret, shown once and never recoverable from this server afterwards in any other form
 */
export function newWebhookSecret(): string {
	return `whsec_${randomBytes(32).toString("hex")}`;
}

/**
 * Signs one delivery.
 *
 * @param secret the subscription's shared secret
 * @param body the exact JSON text that will be sent
 * @param at the moment to stamp; injectable so tests need no clock control
 * @returns the value for the `X-FenPOS-Signature` header
 */
export function signPayload(secret: string, body: string, at: Date = new Date()): string {
	const t = Math.floor(at.getTime() / 1000);
	return `t=${t},v1=${digest(secret, t, body)}`;
}

/**
 * Verifies a delivery, the way a receiver would.
 *
 * Not used by this server, which receives no webhooks. It exists so the signing scheme is tested
 * against a real verifier rather than against a restatement of `signPayload`, and so the docs page
 * can point integrators at an implementation known to work against what is actually sent.
 *
 * @param secret the subscription's shared secret
 * @param body the received body, exactly as it arrived
 * @param header the received `X-FenPOS-Signature` value
 * @param now the receiver's clock; injectable for tests
 * @param toleranceSeconds how stale a delivery may be
 * @returns whether the delivery is authentic and recent
 */
export function verifySignature(
	secret: string,
	body: string,
	header: string,
	now: Date = new Date(),
	toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): boolean {
	const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header.trim());
	if (!match) {
		return false;
	}

	const t = Number(match[1]);
	if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceSeconds) {
		return false;
	}

	const expected = Buffer.from(digest(secret, t, body), "hex");
	const presented = Buffer.from(match[2], "hex");

	// Constant time, so a receiver copying this cannot be walked towards a valid digest one byte at
	// a time. Lengths are equal by construction — both are a SHA-256 digest — but checked anyway,
	// because `timingSafeEqual` throws on a mismatch and a verifier must return false, not crash.
	return expected.length === presented.length && timingSafeEqual(expected, presented);
}

/**
 * The HMAC over the signed material.
 *
 * @param secret the shared secret
 * @param t the unix timestamp being signed
 * @param body the payload text
 * @returns the hex digest
 */
function digest(secret: string, t: number, body: string): string {
	return createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
}
