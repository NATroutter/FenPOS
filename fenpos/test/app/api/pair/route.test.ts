import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { API_ERROR_STATUS } from "@/lib/errors";
import { PROTOCOL_VERSION } from "@/lib/link/protocol";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Tests for `pairing.enabled`, the kill switch on `/api/pair` — the one unauthenticated write
 * in the system.
 *
 * The test that matters most here is not "does it refuse" but "does it refuse *identically* to
 * a wrong code" (below). A disabled endpoint that answered with its own message would be a probe:
 * a caller could tell "pairing is worth attacking" from "it is switched off" without guessing a
 * single character of a code — including by volume alone, with no correct guess at all (see the
 * rate-limiter test below). Every comparison asserts on the actual status and parsed body — not
 * on an error class — because a route with the check silently deleted still throws `ApiError` by
 * a different path (`redeemPairingCode` returning `ok: false` for an unrecognised code), which
 * would let a weaker assertion pass against broken code.
 *
 * `redeemPairingCode` is wrapped in a spy (real implementation preserved) so the "never looked up"
 * claim is checked directly rather than inferred from a side effect.
 */
vi.mock("next/headers", () => ({
	headers: vi.fn(async () => new Headers({ "x-forwarded-for": "203.0.113.5" })),
}));

vi.mock("@/lib/agents/pairing", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/agents/pairing")>();
	return { ...actual, redeemPairingCode: vi.fn(actual.redeemPairingCode) };
});

const { POST } = await import("@/app/api/pair/route");
const { issuePairingCode, redeemPairingCode } = await import("@/lib/agents/pairing");
const { pairingLimiter } = await import("@/lib/auth/rate-limit");

const CLIENT_ADDRESS = "203.0.113.5";

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
		pairingLimiter.reset(CLIENT_ADDRESS);
		vi.mocked(redeemPairingCode).mockClear();

		const agent = await prisma.agent.create({ data: { name: `agent-${Date.now()}-${Math.random()}` } });
		const issued = await issuePairingCode(agent.id);
		validCode = issued.code;
	});

	afterEach(() => {
		pairingLimiter.reset(CLIENT_ADDRESS);
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
	 * The critical case a single-request comparison cannot see: the rate limiter must be consumed
	 * the same way whether pairing is on or off, or a caller who sends enough volume — no correct
	 * guess required — can tell the two states apart. Before `route.ts` consumed the limiter
	 * unconditionally, an enabled install answered request #11 with 429 `rate_limited` while a
	 * disabled one kept answering 401 forever, because the limiter was never reached. This floods
	 * both scenarios past the limit and asserts the responses at that exact point — status and
	 * parsed body, not an error class — are the same.
	 */
	it("answers identically under volume, once each scenario exhausts the rate limiter", async () => {
		const flood = async (body: Record<string, unknown>): Promise<Response> => {
			pairingLimiter.reset(CLIENT_ADDRESS);
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
