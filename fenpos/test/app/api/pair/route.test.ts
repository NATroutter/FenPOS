import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { API_ERROR_STATUS } from "@/lib/errors";
import { PROTOCOL_VERSION } from "@/lib/link/protocol";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Tests for `pairing.enabled`, the kill switch on `/api/pair` — the one unauthenticated write
 * in the system — and for the two rate limiters that guard it.
 *
 * The test that matters most in the first block is not "does it refuse" but "does it refuse
 * *identically* to a wrong code" (below). A disabled endpoint that answered with its own message
 * would be a probe: a caller could tell "pairing is worth attacking" from "it is switched off"
 * without guessing a single character of a code — including by volume alone, with no correct
 * guess at all (see the volume test below). Every comparison asserts on the actual status and
 * parsed body — not on an error class — because a route with the check silently deleted still
 * throws `ApiError` by a different path (`redeemPairingCode` returning `ok: false` for an
 * unrecognised code), which would let a weaker assertion pass against broken code.
 *
 * `redeemPairingCode` is wrapped in a spy (real implementation preserved) so the "never looked up"
 * claim is checked directly rather than inferred from a side effect.
 *
 * `@/lib/request-context` is mocked outright, rather than driven through `next/headers` and the
 * trusted-proxy settings, so a test can put the peer and the resolved client address on two
 * different values directly — which is the entire distinction the second block exists to check.
 * How those two get resolved from headers and settings is `request-context.test.ts`'s job.
 */
vi.mock("next/headers", () => ({
	headers: vi.fn(async () => new Headers()),
}));

/** What `getPeerAddress` and `getClientAddress` currently return; set by `actingAs` below. */
let currentPeer = "203.0.113.5";
let currentAddress = "203.0.113.5";

vi.mock("@/lib/request-context", () => ({
	getPeerAddress: vi.fn(async () => currentPeer),
	getClientAddress: vi.fn(async () => currentAddress),
}));

vi.mock("@/lib/agents/pairing", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/agents/pairing")>();
	return { ...actual, redeemPairingCode: vi.fn(actual.redeemPairingCode) };
});

const { POST } = await import("@/app/api/pair/route");
const { issuePairingCode, redeemPairingCode } = await import("@/lib/agents/pairing");
const { pairingFloodLimiter, pairingLimiter } = await import("@/lib/auth/rate-limit");

const CLIENT_ADDRESS = "203.0.113.5";

/**
 * Points both the peer and the resolved client address at one caller — the ordinary case, with
 * no proxy translating one into the other.
 *
 * @param address what both `getPeerAddress` and `getClientAddress` should resolve to
 */
function actingAs(address: string): void {
	currentPeer = address;
	currentAddress = address;
}

/**
 * Puts two different callers behind one shared peer — the case a reverse proxy produces, and the
 * one the two-tier split below exists for.
 *
 * @param peer the value every caller behind this proxy shares
 * @param address the one this particular caller resolves to
 */
function behindSharedPeer(peer: string, address: string): void {
	currentPeer = peer;
	currentAddress = address;
}

/**
 * Builds a pairing request body, filling in the protocol version every real caller sends.
 *
 * @param body fields to override or add
 * @returns a `Request` ready to hand to `POST`
 */
function requestWith(body: Record<string, unknown>): Request {
	return new Request("https://fenpos.test/api/pair", {
		method: "POST",
		body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body }),
	});
}

describe("POST /api/pair — pairing.enabled", () => {
	let validCode: string;

	beforeEach(async () => {
		await prisma.pairingCode.deleteMany();
		await prisma.agent.deleteMany();
		await prisma.setting.deleteMany();
		actingAs(CLIENT_ADDRESS);
		pairingLimiter.reset(CLIENT_ADDRESS);
		pairingFloodLimiter.reset(CLIENT_ADDRESS);
		vi.mocked(redeemPairingCode).mockClear();

		const agent = await prisma.agent.create({ data: { name: `agent-${Date.now()}-${Math.random()}` } });
		const issued = await issuePairingCode(agent.id);
		validCode = issued.code;
	});

	afterEach(() => {
		pairingLimiter.reset(CLIENT_ADDRESS);
		pairingFloodLimiter.reset(CLIENT_ADDRESS);
	});

	it("pairs successfully with a valid code while pairing is on (sanity check for the tests below)", async () => {
		const response = await POST(requestWith({ code: validCode }));
		expect(response.status).toBe(200);
	});

	it("refuses to pair when pairing is switched off", async () => {
		await setSetting("pairing.enabled", false);

		const response = await POST(requestWith({ code: validCode }));

		expect(response.status).toBe(401);
	});

	it("is indistinguishable from a wrong code when switched off", async () => {
		await setSetting("pairing.enabled", false);

		const disabled = await POST(requestWith({ code: validCode }));
		const disabledBody = await disabled.json();

		await setSetting("pairing.enabled", true);
		const wrong = await POST(requestWith({ code: "WRONGWRONGWR" }));
		const wrongBody = await wrong.json();

		expect(disabled.status).toBe(wrong.status);
		expect(disabledBody).toEqual(wrongBody);
	});

	it("never looks up the code at all when pairing is switched off", async () => {
		// The real claim: the route must not reach redeemPairingCode. A test that only checked
		// the response would pass even if the check ran after the lookup and merely overwrote
		// its result.
		await setSetting("pairing.enabled", false);

		await POST(requestWith({ code: validCode }));

		expect(redeemPairingCode).not.toHaveBeenCalled();
	});

	it("leaves a still-valid code unconsumed while switched off", async () => {
		await setSetting("pairing.enabled", false);
		await POST(requestWith({ code: validCode }));

		await setSetting("pairing.enabled", true);
		const response = await POST(requestWith({ code: validCode }));

		expect(response.status).toBe(200);
	});

	/**
	 * The critical case a single-request comparison cannot see: both limiters must be consumed
	 * the same way whether pairing is on or off, or a caller who sends enough volume — no correct
	 * guess required — can tell the two states apart. Before `route.ts` consumed them
	 * unconditionally, an enabled install answered the request that exhausted a limiter with 429
	 * `rate_limited` while a disabled one kept answering 401 forever, because the limiter was
	 * never reached. This floods both scenarios past the tight limit and asserts the responses at
	 * that exact point — status and parsed body, not an error class — are the same.
	 */
	it("answers identically under volume, once each scenario exhausts the rate limiter", async () => {
		const flood = async (body: Record<string, unknown>): Promise<Response> => {
			pairingLimiter.reset(CLIENT_ADDRESS);
			pairingFloodLimiter.reset(CLIENT_ADDRESS);
			let last: Response = await POST(requestWith(body));
			for (let i = 1; i < 11; i++) {
				last = await POST(requestWith(body));
			}
			return last;
		};

		await setSetting("pairing.enabled", false);
		const disabledLast = await flood({ code: validCode });
		const disabledBody = await disabledLast.json();

		await setSetting("pairing.enabled", true);
		const enabledLast = await flood({ code: "WRONGWRONGWR" });
		const enabledBody = await enabledLast.json();

		expect(disabledLast.status).toBe(API_ERROR_STATUS.rate_limited);
		expect(enabledLast.status).toBe(API_ERROR_STATUS.rate_limited);
		expect(disabledBody).toEqual(enabledBody);
	});
});

/**
 * Tests for the split between `pairingFloodLimiter` (peer-keyed, loose) and `pairingLimiter`
 * (address-keyed, tight) — the reason both exist rather than one limiter keyed on the peer.
 *
 * A single shared peer is exactly what every caller behind one reverse proxy looks like, which
 * this project's own README recommends running behind. If the tight budget were still keyed on
 * the peer, one caller exhausting it would spend every other caller's guesses too; the point of
 * resolving the client address before the tight check is that it does not.
 */
describe("POST /api/pair — flood limiter and pairing limiter", () => {
	const SHARED_PEER = "198.51.100.1";
	const CALLER_A = "203.0.113.10";
	const CALLER_B = "203.0.113.11";

	let validCode: string;

	beforeEach(async () => {
		await prisma.pairingCode.deleteMany();
		await prisma.agent.deleteMany();
		await prisma.setting.deleteMany();
		for (const key of [SHARED_PEER, CALLER_A, CALLER_B]) {
			pairingLimiter.reset(key);
			pairingFloodLimiter.reset(key);
		}
		vi.mocked(redeemPairingCode).mockClear();

		const agent = await prisma.agent.create({ data: { name: `agent-${Date.now()}-${Math.random()}` } });
		const issued = await issuePairingCode(agent.id);
		validCode = issued.code;
	});

	afterEach(() => {
		actingAs(CLIENT_ADDRESS);
		for (const key of [SHARED_PEER, CALLER_A, CALLER_B]) {
			pairingLimiter.reset(key);
			pairingFloodLimiter.reset(key);
		}
	});

	it("does not let one caller behind a shared peer spend a different caller's tight budget", async () => {
		behindSharedPeer(SHARED_PEER, CALLER_A);
		let last: Response = await POST(requestWith({ code: "WRONGWRONGWR" }));
		for (let i = 1; i < 11; i++) {
			last = await POST(requestWith({ code: "WRONGWRONGWR" }));
		}
		// CALLER_A is now out of tight budget (11 requests against a limit of 10), but nowhere
		// near the flood limiter's own ceiling of 60 on the shared peer.
		expect(last.status).toBe(API_ERROR_STATUS.rate_limited);

		// CALLER_B arrives through the same proxy, so it shares SHARED_PEER — and, with a valid
		// code, is paired without ever being told CALLER_A had already exhausted its guesses.
		behindSharedPeer(SHARED_PEER, CALLER_B);
		const response = await POST(requestWith({ code: validCode }));

		expect(response.status).toBe(200);
	});

	it("still refuses a flood spread across many resolved addresses behind one peer", async () => {
		// Each address here gets a fresh tight budget, since the tight limiter is keyed on the
		// resolved address — so no single one of these requests is refused by pairingLimiter. What
		// catches the flood is pairingFloodLimiter, keyed on the one peer they all share.
		let last: Response | undefined;
		for (let i = 0; i < 61; i++) {
			behindSharedPeer(SHARED_PEER, `203.0.113.${20 + i}`);
			last = await POST(requestWith({ code: "WRONGWRONGWR" }));
		}

		expect(last?.status).toBe(API_ERROR_STATUS.rate_limited);
	});

	it("does not let a successful pairing hand the shared peer a fresh flood budget", async () => {
		// Spend most of the shared peer's flood budget first, across many different resolved
		// addresses so no single address's own tight budget (limit 10) is ever exhausted here.
		for (let i = 0; i < 55; i++) {
			behindSharedPeer(SHARED_PEER, `203.0.113.${100 + i}`);
			await POST(requestWith({ code: "WRONGWRONGWR" }));
		}

		// A fresh address behind the same peer, with room in both budgets, pairs successfully —
		// bringing the shared peer's flood count to 56 of 60.
		behindSharedPeer(SHARED_PEER, CALLER_A);
		const paired = await POST(requestWith({ code: validCode }));
		expect(paired.status).toBe(200);

		// Only 4 of the shared peer's 60 requests remain. If the reset above had cleared the flood
		// limiter along with the tight one, a fresh caller behind the same peer would see a full
		// budget here instead of running out on its 5th request.
		behindSharedPeer(SHARED_PEER, CALLER_B);
		let last: Response = await POST(requestWith({ code: "WRONGWRONGWR" }));
		for (let i = 1; i < 5; i++) {
			last = await POST(requestWith({ code: "WRONGWRONGWR" }));
		}

		expect(last.status).toBe(API_ERROR_STATUS.rate_limited);
	});
});
