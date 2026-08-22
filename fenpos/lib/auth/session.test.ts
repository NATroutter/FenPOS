import { beforeEach, describe, expect, it } from "vitest";
import { hashSecret } from "@/lib/auth/secrets";
import {
	createSession,
	destroyAllSessions,
	destroySession,
	purgeExpiredSessions,
	resolveSession,
	sessionLifetimePhrase,
} from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Exercises the session lifecycle against a real database.
 *
 * Time is passed explicitly rather than faked globally, so expiry is asserted without any
 * sleeping and the tests stay deterministic under parallel execution.
 */
describe("session lifecycle", () => {
	const now = new Date("2026-08-18T10:00:00.000Z");

	/** The `auth.sessionHours` fallback (`settings-service.ts`), in milliseconds, for tests that leave it unset. */
	const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

	beforeEach(async () => {
		await prisma.session.deleteMany({});
		await prisma.setting.deleteMany({ where: { key: "auth.sessionHours" } });
	});

	it("creates a session that resolves immediately", async () => {
		const { token } = await createSession({}, now);
		await expect(resolveSession(token, now)).resolves.not.toBeNull();
	});

	it("stores only the hash, never the token", async () => {
		const { token } = await createSession({}, now);

		const rows = await prisma.session.findMany({ select: { tokenHash: true } });
		expect(rows).toHaveLength(1);
		expect(rows[0].tokenHash).toBe(hashSecret(token));
		expect(rows[0].tokenHash).not.toBe(token);
	});

	it("expires exactly at the default TTL", async () => {
		const { token, expiresAt } = await createSession({}, now);
		expect(expiresAt.getTime()).toBe(now.getTime() + DEFAULT_SESSION_TTL_MS);

		const justBefore = new Date(now.getTime() + DEFAULT_SESSION_TTL_MS - 1);
		await expect(resolveSession(token, justBefore)).resolves.not.toBeNull();

		const atExpiry = new Date(now.getTime() + DEFAULT_SESSION_TTL_MS);
		await expect(resolveSession(token, atExpiry)).resolves.toBeNull();
	});

	it("issues a session lasting the configured number of hours", async () => {
		await setSetting("auth.sessionHours", 1);
		const { expiresAt } = await createSession({}, now);

		expect(expiresAt.getTime()).toBe(now.getTime() + 60 * 60 * 1000);
	});

	it("does not shorten a session already issued when the setting changes afterwards", async () => {
		// The expiry is stamped in at creation, not recomputed on read. An operator shortening
		// the lifetime after, say, a laptop goes missing is not achieving what they might
		// think — the fix for that is signing the session out, not this setting.
		const { token, expiresAt } = await createSession({}, now);
		expect(expiresAt.getTime()).toBe(now.getTime() + DEFAULT_SESSION_TTL_MS);

		await setSetting("auth.sessionHours", 1);

		const anHourAndAHalfLater = new Date(now.getTime() + 90 * 60 * 1000);
		await expect(resolveSession(token, anHourAndAHalfLater)).resolves.not.toBeNull();
	});

	it("deletes an expired row as it is read, so expiry does not depend on a sweep", async () => {
		const { token } = await createSession({}, now);
		await resolveSession(token, new Date(now.getTime() + DEFAULT_SESSION_TTL_MS + 1));

		expect(await prisma.session.count()).toBe(0);
	});

	it("rejects an unknown token", async () => {
		await expect(resolveSession("not-a-real-token", now)).resolves.toBeNull();
	});

	it("rejects an empty token without querying", async () => {
		await expect(resolveSession("", now)).resolves.toBeNull();
	});

	it("revokes a single session on sign-out", async () => {
		const first = await createSession({}, now);
		const second = await createSession({}, now);

		await destroySession(first.token);

		await expect(resolveSession(first.token, now)).resolves.toBeNull();
		await expect(resolveSession(second.token, now)).resolves.not.toBeNull();
	});

	it("revokes every session, which is what a password change must do", async () => {
		const first = await createSession({}, now);
		const second = await createSession({}, now);

		expect(await destroyAllSessions()).toBe(2);

		await expect(resolveSession(first.token, now)).resolves.toBeNull();
		await expect(resolveSession(second.token, now)).resolves.toBeNull();
	});

	it("records request origin for display", async () => {
		await createSession({ userAgent: "Firefox", ipAddress: "10.0.0.7" }, now);

		const row = await prisma.session.findFirst({ select: { userAgent: true, ipAddress: true } });
		expect(row).toEqual({ userAgent: "Firefox", ipAddress: "10.0.0.7" });
	});

	it("issues a distinct token per session", async () => {
		const first = await createSession({}, now);
		const second = await createSession({}, now);
		expect(first.token).not.toBe(second.token);
	});

	it("refreshes last-seen only once it is stale, to avoid a write per request", async () => {
		const { token } = await createSession({}, now);

		const soon = new Date(now.getTime() + 60_000);
		await resolveSession(token, soon);
		const unchanged = await prisma.session.findFirst({ select: { lastSeenAt: true } });
		expect(unchanged?.lastSeenAt.toISOString()).toBe(now.toISOString());

		const later = new Date(now.getTime() + 10 * 60_000);
		await resolveSession(token, later);
		const refreshed = await prisma.session.findFirst({ select: { lastSeenAt: true } });
		expect(refreshed?.lastSeenAt.toISOString()).toBe(later.toISOString());
	});

	it("purges only sessions that have expired", async () => {
		const live = await createSession({}, now);
		const stale = await createSession({}, new Date(now.getTime() - DEFAULT_SESSION_TTL_MS));

		expect(await purgeExpiredSessions(now)).toBe(1);

		await expect(resolveSession(live.token, now)).resolves.not.toBeNull();
		await expect(resolveSession(stale.token, now)).resolves.toBeNull();
	});
});

/**
 * Boundary tests for the sign-in page footer's session-lifetime sentence, at `auth.sessionHours`'s
 * declared `min` and `max` (`settings-service.ts`), and 1 — the count whose grammar the format
 * string could get wrong. Mirrors `signInThrottlePhrase`'s tests (`rate-limit.test.ts`) and
 * `minimumLengthPhrase`'s (`password-policy.test.ts`).
 */
describe("sessionLifetimePhrase", () => {
	it("uses the singular at exactly one", () => {
		expect(sessionLifetimePhrase(1)).toBe("1 hour");
	});

	it("uses the plural at the setting's fallback", () => {
		expect(sessionLifetimePhrase(12)).toBe("12 hours");
	});

	it("uses the plural at the setting's maximum", () => {
		expect(sessionLifetimePhrase(720)).toBe("720 hours");
	});
});
