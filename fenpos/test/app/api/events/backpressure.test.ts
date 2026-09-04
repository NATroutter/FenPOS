import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelUser } from "@/lib/auth/require-session";

/**
 * What the live stream does when its client stops reading.
 *
 * Every job update, log line, agent and device event in the install is fanned out to every open
 * stream, so a connection that has stopped consuming is not a slow client but a place for the whole
 * firehose to accumulate, once per stalled connection, for as long as it lasts. `controller.enqueue`
 * succeeds either way and simply grows the queue, which leaves `desiredSize` as the only thing on
 * this side that can tell a stalled client from a quiet one.
 *
 * Asserted rather than left to review because the failure is invisible in ordinary use: a stream
 * that buffers without bound behaves exactly like one that does not, right up until the process runs
 * out of memory. Both halves are covered here, because a route that closed every stream the moment
 * two events arrived between reads would pass a test that only proved the stalled one gets closed.
 */
const currentUser = vi.fn<() => Promise<PanelUser | null>>(async () => ({
	id: "stream-user",
	name: "Stream User",
	email: "stream@example.com",
	isSuperuser: true,
	mustChangePassword: false,
	sessionId: "session-stream-user",
	twoFactorEnabled: false,
}));
vi.mock("@/lib/auth/require-session", async (importActual) => ({
	...(await importActual<typeof import("@/lib/auth/require-session")>()),
	currentUser: () => currentUser(),
}));

// `sessionVerdict` reads the caller's address for the allowlist gate, and `next/headers` raises
// outside a live request.
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.30",
	getUserAgent: async () => "vitest",
}));

const { GET } = await import("@/app/api/events/route");
const { publish, subscriberCount } = await import("@/lib/events/bus");
const { prisma } = await import("@/lib/db");

/**
 * Enough text per event that the stream's byte budget is reached in a countable number of them
 * rather than in tens of thousands, and close enough to a real log line to be worth measuring.
 */
const MESSAGE = "x".repeat(200);

/** Comfortably more events than the buffer can hold, so a route that never drops would take them all. */
const FAR_MORE_THAN_FITS = 20_000;

/** Few enough to sit well inside the buffer, standing in for a client that is simply between reads. */
const FITS_EASILY = 100;

function logEvent(index: number) {
	return {
		kind: "log",
		id: `evt-${index}`,
		at: new Date().toISOString(),
		level: "INFO",
		message: MESSAGE,
		agentId: "a",
		deviceName: null,
	} as const;
}

/** Opens a stream and never reads its body, which is what a wedged client looks like from here. */
async function openUnreadStream(sessionId: string): Promise<AbortController> {
	currentUser.mockResolvedValue({
		id: "stream-user",
		name: "Stream User",
		email: "stream@example.com",
		isSuperuser: true,
		mustChangePassword: false,
		sessionId,
		twoFactorEnabled: false,
	});
	const abort = new AbortController();
	const response = await GET(new Request("https://fenpos.test/api/events", { signal: abort.signal }));
	expect(response.status).toBe(200);
	expect(subscriberCount()).toBe(1);
	return abort;
}

beforeEach(async () => {
	await prisma.setting.deleteMany();
});
afterEach(async () => {
	await prisma.setting.deleteMany();
});

describe("panel event stream backpressure", () => {
	it("closes a stream that stopped reading instead of queueing the firehose behind it", async () => {
		const abort = await openUnreadStream("session-stalled");

		// Published one at a time so the point the route gives up is observable. A route that never
		// consulted `desiredSize` would still be subscribed after every one of these.
		let published = 0;
		while (subscriberCount() === 1 && published < FAR_MORE_THAN_FITS) {
			publish(logEvent(published));
			published++;
		}

		// Closing unsubscribes, so the count going to zero is the whole defence: no further event in
		// the install is written towards this connection, and the queue it had is released with it.
		expect(subscriberCount()).toBe(0);
		// And it happened on its own, well before the burst ran out, which is what makes the memory
		// held per stalled connection bounded rather than merely large.
		expect(published).toBeLessThan(FAR_MORE_THAN_FITS);

		abort.abort();
	});

	it("keeps a stream whose client is only between reads", async () => {
		const abort = await openUnreadStream("session-quiet");

		for (let index = 0; index < FITS_EASILY; index++) {
			publish(logEvent(index));
		}

		// Still subscribed: this many events sit inside the byte budget, and dropping them would make
		// the panel lose updates on any connection that paused for a moment.
		expect(subscriberCount()).toBe(1);

		abort.abort();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(subscriberCount()).toBe(0);
	});
});
