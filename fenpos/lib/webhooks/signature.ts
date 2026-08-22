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
 *
 * The header parser is stricter than most conventional verifiers: it anchors the whole string and
 * accepts only `t` and `v1`, so a future `t=…,v1=…,v2=…` would be refused rather than silently
 * accepted. That is deliberate — fail-closed is the right default for an unrecognised parameter —
 * but it means introducing a `v2` scheme later means versioning this parser too, not just adding a
 * field.
 */

/** How far a delivery's timestamp may be from the receiver's clock, by default, in seconds. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Generates a subscription secret.
 *
 * Prefixed so that a secret found in a receiver's configuration is recognisable for what it is —
 * the same reason API keys carry a prefix.
 *
 * Unlike a password, this is stored in plaintext: this server is the *sender*, and has to hold the
 * secret to sign with it, so hashing it would make signing impossible. That makes it a live
 * credential at rest, not an at-rest artifact that only needs to survive a comparison — it deserves
 * the handling of a plaintext secret everywhere it is stored, logged, and displayed.
 *
 * @returns a new secret
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
	// This is the reference implementation an integrator copies, and their `header` is commonly
	// `req.headers["x-fenpos-signature"]` — `undefined` when the delivery carries no signature at
	// all. TypeScript guarantees a string at every call site in this codebase, but a copied verifier
	// running in plain JS would crash on `.trim()` here instead of correctly returning false.
	if (typeof header !== "string") {
		return false;
	}

	const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header.trim());
	if (!match) {
		return false;
	}

	const t = Number(match[1]);
	const nowSeconds = Math.floor(now.getTime() / 1000);
	// An invalid `now` or a non-finite tolerance must reject, not silently pass: `NaN > n` and
	// `n > NaN` are both `false`, so without this guard a bad clock would disable the one check that
	// stops a replay, while the digest comparison below kept running as if nothing were wrong. An
	// attacker never controls `now` — only the header and body — but this is still the module's only
	// comparison that fails open, and it is the anti-replay one.
	if (!Number.isFinite(nowSeconds) || !Number.isFinite(toleranceSeconds)) {
		return false;
	}
	if (Math.abs(nowSeconds - t) > toleranceSeconds) {
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
