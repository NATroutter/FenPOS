import { describe, expect, it } from "vitest";
import { newWebhookSecret, signPayload, verifySignature } from "@/lib/webhooks/signature";

/**
 * The signature a receiver checks to know a delivery came from this install.
 *
 * The timestamp is inside the signed material, not beside it. Without that, a delivery captured
 * from the wire could be replayed at any later time with its signature still valid — and the
 * receiver would print, refund, or reconcile against an event from last week.
 */

const SECRET = "whsec_test";
const BODY = '{"event":"job.settled","jobId":"job-1"}';

describe("signPayload", () => {
	it("produces a header carrying the timestamp and the digest", () => {
		const header = signPayload(SECRET, BODY, new Date("2026-08-22T10:00:00.000Z"));

		expect(header).toMatch(/^t=1787392800,v1=[0-9a-f]{64}$/);
	});

	it("is stable for the same secret, body and moment", () => {
		const at = new Date("2026-08-22T10:00:00.000Z");

		expect(signPayload(SECRET, BODY, at)).toBe(signPayload(SECRET, BODY, at));
	});

	it("changes when the body changes", () => {
		const at = new Date("2026-08-22T10:00:00.000Z");

		expect(signPayload(SECRET, BODY, at)).not.toBe(signPayload(SECRET, `${BODY} `, at));
	});

	it("changes when the secret changes", () => {
		const at = new Date("2026-08-22T10:00:00.000Z");

		expect(signPayload(SECRET, BODY, at)).not.toBe(signPayload("whsec_other", BODY, at));
	});
});

describe("verifySignature", () => {
	it("accepts a signature this module just produced", () => {
		const at = new Date("2026-08-22T10:00:00.000Z");

		expect(verifySignature(SECRET, BODY, signPayload(SECRET, BODY, at), at)).toBe(true);
	});

	it("rejects a body that was altered in flight", () => {
		const at = new Date("2026-08-22T10:00:00.000Z");
		const header = signPayload(SECRET, BODY, at);

		expect(verifySignature(SECRET, '{"event":"job.settled","jobId":"job-2"}', header, at)).toBe(false);
	});

	it("rejects a signature made with another secret", () => {
		const at = new Date("2026-08-22T10:00:00.000Z");

		expect(verifySignature(SECRET, BODY, signPayload("whsec_other", BODY, at), at)).toBe(false);
	});

	it("rejects a delivery replayed outside the tolerance", () => {
		const signedAt = new Date("2026-08-22T10:00:00.000Z");
		const header = signPayload(SECRET, BODY, signedAt);
		const muchLater = new Date("2026-08-22T11:00:00.000Z");

		expect(verifySignature(SECRET, BODY, header, muchLater, 300)).toBe(false);
	});

	it("rejects a captured header whose timestamp is rewritten to the present, keeping the original digest", () => {
		// This is the test that fails if the timestamp ever leaves the signed material — e.g. if
		// `digest` were changed to hash the body alone. Verifying at `freshNow` (rather than at
		// `signedAt`) takes the tolerance check out of the picture entirely: `freshT` is always within
		// tolerance of `freshNow` by construction, so the only thing left that can reject this rewritten
		// header is the digest binding `t` to `v1`.
		const signedAt = new Date("2026-08-22T10:00:00.000Z");
		const header = signPayload(SECRET, BODY, signedAt);

		const freshNow = new Date("2026-08-25T00:00:00.000Z");
		const freshT = Math.floor(freshNow.getTime() / 1000);
		const replayed = header.replace(/^t=\d+/, `t=${freshT}`);

		expect(verifySignature(SECRET, BODY, replayed, freshNow)).toBe(false);
	});

	it("rejects a malformed header rather than throwing", () => {
		expect(verifySignature(SECRET, BODY, "nonsense")).toBe(false);
		expect(verifySignature(SECRET, BODY, "t=abc,v1=zz")).toBe(false);
		expect(verifySignature(SECRET, BODY, "")).toBe(false);
	});
});

describe("newWebhookSecret", () => {
	it("is prefixed so it is recognisable in a receiver's configuration", () => {
		expect(newWebhookSecret()).toMatch(/^whsec_[0-9a-f]{64}$/);
	});

	it("differs every time", () => {
		expect(newWebhookSecret()).not.toBe(newWebhookSecret());
	});
});
