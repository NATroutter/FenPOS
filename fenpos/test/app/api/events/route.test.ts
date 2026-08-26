import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelUser } from "@/lib/auth/require-session";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";
import { settled } from "@/test/settled";

/**
 * Tests for the live stream's keepalive comment and its session gate.
 *
 * No test file covered this route before `events.keepaliveSeconds` existed — `KEEPALIVE_MS` was a
 * literal constant nothing exercised. What matters is that the configured value reaches the
 * `setInterval` the stream arms on open: the comment must not appear before the configured number
 * of seconds, and must appear once they pass — a test that only checked the second half would still
 * pass against the route's old hardcoded twenty-five seconds.
 *
 * The gate tests below exist because this route cannot use `requireSession` — see the route's own
 * comment — and once repeated `requireSession`'s `mustChangePassword` check by hand, missing the
 * three gates added around it. Only `currentUser` is stubbed here: `sessionVerdict` is the real one,
 * against the real database, so a gate this route stops running is a failure in this file rather
 * than a hole nobody notices.
 */
const currentUser = vi.fn<() => Promise<PanelUser | null>>(async () => ({
	id: "test-user",
	name: "Test User",
	email: "test@example.com",
	isSuperuser: true,
	mustChangePassword: false,
	sessionId: "session-test-user",
	twoFactorEnabled: false,
}));
vi.mock("@/lib/auth/require-session", async (importActual) => ({
	...(await importActual<typeof import("@/lib/auth/require-session")>()),
	currentUser: () => currentUser(),
}));

// `sessionVerdict` reads the caller's address for the allowlist gate, and `next/headers` raises
// outside a live request. A fixed address stands in, so the allowlist tests below turn on what is
// configured rather than on what the runtime could see.
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.30",
	getUserAgent: async () => "vitest",
}));

const { GET } = await import("@/app/api/events/route");

beforeEach(async () => {
	await prisma.setting.deleteMany();
	await prisma.session.deleteMany();
	await prisma.user.deleteMany();
	currentUser.mockReset().mockResolvedValue({
		id: "test-user",
		name: "Test User",
		email: "test@example.com",
		isSuperuser: true,
		mustChangePassword: false,
		sessionId: "session-test-user",
		twoFactorEnabled: false,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("GET /api/events session gate", () => {
	it("refuses a caller with no session", async () => {
		currentUser.mockResolvedValue(null);

		const response = await GET(new Request("https://fenpos.test/api/events"));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "missing_key", message: "Not signed in." });
	});

	it("refuses a session that still owes a password change", async () => {
		currentUser.mockResolvedValue({
			id: "test-user",
			name: "Test User",
			email: "test@example.com",
			isSuperuser: false,
			mustChangePassword: true,
			sessionId: "session-test-user",
			twoFactorEnabled: false,
		});

		const response = await GET(new Request("https://fenpos.test/api/events"));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "missing_key", message: "Not signed in." });
	});

	/**
	 * The gate `auth.require2fa` is bought for. An account with a password and no authenticator is
	 * refused every panel page on such an install; the stream carries more than any of those pages
	 * shows, so a stolen password must not reach it either.
	 */
	it("refuses an account with no authenticator while two-factor is required", async () => {
		await setSetting("auth.require2fa", true);

		const response = await GET(new Request("https://fenpos.test/api/events"));

		expect(response.status).toBe(401);
	});

	it("admits an enrolled account while two-factor is required", async () => {
		await setSetting("auth.require2fa", true);
		currentUser.mockResolvedValue({
			id: "test-user",
			name: "Test User",
			email: "test@example.com",
			isSuperuser: true,
			mustChangePassword: false,
			sessionId: "session-test-user",
			twoFactorEnabled: true,
		});

		const abort = new AbortController();
		const response = await GET(new Request("https://fenpos.test/api/events", { signal: abort.signal }));

		expect(response.status).toBe(200);
		abort.abort();
	});

	it("refuses a session that has sat past the inactivity timeout", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		const staleAt = new Date(Date.now() - 40 * 60 * 1000);
		await prisma.user.create({ data: { id: "test-user", name: "Test User", email: "test@example.com" } });
		await prisma.session.create({
			data: {
				id: "session-test-user",
				token: "t-session-test-user",
				userId: "test-user",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				createdAt: staleAt,
				updatedAt: staleAt,
				lastSeenAt: staleAt,
			},
		});

		const response = await GET(new Request("https://fenpos.test/api/events"));

		expect(response.status).toBe(401);
	});

	/**
	 * The other half of sharing the panel's gates: the stream runs them, but it must not *count* as
	 * the panel being used.
	 *
	 * `EventSource` reopens this connection by itself after every drop, and the route's own keepalive
	 * exists because proxies drop it. So a stamp refreshed here is a stamp refreshed by nobody: an
	 * unattended terminal on a lossy network would never reach `auth.idleTimeoutMinutes`, and an
	 * abandoned tab would outrank a working session in `enforceSessionCap`'s least-recently-used
	 * ordering. Twenty minutes stale against a thirty-minute timeout is well past the refresh interval,
	 * so a gate that touched the row would rewrite it here.
	 */
	it("does not count as activity: an opened stream leaves last-seen where it was", async () => {
		await setSetting("auth.idleTimeoutMinutes", 30);
		await setSetting("auth.lastSeenRefreshMinutes", 5);
		const seenAt = new Date(Date.now() - 20 * 60 * 1000);
		await prisma.user.create({ data: { id: "test-user", name: "Test User", email: "test@example.com" } });
		await prisma.session.create({
			data: {
				id: "session-test-user",
				token: "t-session-test-user",
				userId: "test-user",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				createdAt: seenAt,
				updatedAt: seenAt,
				lastSeenAt: seenAt,
			},
		});

		const abort = new AbortController();
		const response = await GET(new Request("https://fenpos.test/api/events", { signal: abort.signal }));
		expect(response.status).toBe(200);
		abort.abort();

		const row = await prisma.session.findUniqueOrThrow({ where: { id: "session-test-user" } });
		expect(row.lastSeenAt?.getTime()).toBe(seenAt.getTime());
	});

	/**
	 * Pre-existing before this route shared the panel's gates, and closed by sharing them: tightening
	 * the allowlist ends panel sessions on their next request, and left alone this stream would have
	 * gone on feeding an address the install no longer accepts.
	 */
	it("refuses a caller whose address no longer qualifies", async () => {
		await setSetting("auth.ipAllowlist", "10.0.0.0/8");

		const response = await GET(new Request("https://fenpos.test/api/events"));

		expect(response.status).toBe(401);
	});
});

describe("GET /api/events keepalive", () => {
	it("sends a keepalive comment at the configured number of seconds, not before", async () => {
		vi.useFakeTimers();
		await setSetting("events.keepaliveSeconds", 5);

		const abort = new AbortController();
		const response = await GET(new Request("https://fenpos.test/api/events", { signal: abort.signal }));
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("expected a streamed response body");
		}
		const decoder = new TextDecoder();

		// The opening comment, sent synchronously so the browser's EventSource fires `open`
		// immediately rather than sitting in CONNECTING.
		const opening = await reader.read();
		expect(decoder.decode(opening.value)).toContain("connected");

		const next = reader.read();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(await settled(next)).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		const chunk = await next;
		expect(decoder.decode(chunk.value)).toContain("keepalive");

		abort.abort();
	});
});
