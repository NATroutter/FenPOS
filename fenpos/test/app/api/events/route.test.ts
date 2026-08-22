import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";
import { settled } from "@/test/settled";

/**
 * Tests for the live stream's keepalive comment.
 *
 * No test file covered this route before `events.keepaliveSeconds` existed — `KEEPALIVE_MS` was a
 * literal constant nothing exercised. What matters is that the configured value reaches the
 * `setInterval` the stream arms on open: the comment must not appear before the configured number
 * of seconds, and must appear once they pass — a test that only checked the second half would still
 * pass against the route's old hardcoded twenty-five seconds.
 */
vi.mock("@/lib/auth/session-cookie", () => ({
	getCurrentSession: async () => ({ id: "test-session", ipAddress: "127.0.0.1", userAgent: null }),
}));

const { GET } = await import("@/app/api/events/route");

beforeEach(async () => {
	await prisma.setting.deleteMany();
});

afterEach(() => {
	vi.useRealTimers();
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
