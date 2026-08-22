import { z } from "zod";
import { redeemPairingCode } from "@/lib/agents/pairing";
import { pairingLimiter } from "@/lib/auth/rate-limit";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { PROTOCOL_VERSION } from "@/lib/link/protocol";
import { logger } from "@/lib/logger";
import { getClientAddress } from "@/lib/request-context";
import { booleanSetting } from "@/lib/settings/settings-service";

/**
 * `POST /api/pair` — exchanges a pairing code for a agent credential.
 *
 * The only unauthenticated write in the system. Everything about it is shaped by that:
 *
 * - Rate limited by client address, which is what makes the code's entropy budget hold. A
 *   twelve-character code is comfortable only because guessing is throttled. The limiter is
 *   consumed unconditionally, before `pairing.enabled` is even read — see that check's own
 *   comment below for why the ordering there is deliberate rather than an oversight.
 * - Every failure returns one identical response. Distinguishing "wrong", "expired" and
 *   "already used" would let a caller map the code space by probing for near-misses. The
 *   server log records which it was.
 * - The body is bounded and fully validated before anything touches the database.
 * - `pairing.enabled`, when off, answers with this same {@link REJECTION} rather than a
 *   distinct message, and before the body is read — otherwise the endpoint would be a probe
 *   telling a caller whether pairing is worth attacking at all.
 */

/** Largest pairing request accepted. The body is four short strings. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * What a agent sends when pairing.
 *
 * The self-reported fields are recorded for display so an operator can recognise an
 * unexpected pairing. They are never trusted for any decision.
 */
const pairRequestSchema = z.object({
	code: z.string().min(1).max(64),
	protocolVersion: z.number().int(),
	agentVersion: z.string().max(64).optional(),
	platform: z.string().max(128).optional(),
	hostname: z.string().max(255).optional(),
});

/** Returned for every rejected redemption, whatever the underlying reason. */
const REJECTION = { error: "invalid_key", message: "That pairing code is not valid." } as const;

export async function POST(request: Request): Promise<Response> {
	const address = await getClientAddress();

	try {
		// Consumed first, unconditionally — before the body is read and before `pairing.enabled`
		// is even checked. Checking `pairing.enabled` first would be cheaper, but it would also
		// mean the limiter's state never advances while pairing is off, and a caller who sends a
		// flood of requests would see request #11 answered differently depending on whether
		// pairing is on (429 rate_limited) or off (401, forever, since the limiter was never
		// touched) — a volume-based oracle for "is this install worth attacking" that needs no
		// correct code at all. Consuming here first keeps the limiter's state, and so the
		// endpoint's behaviour under volume, identical in both cases. Do not "optimise" this back.
		const limit = pairingLimiter.consume(address);
		if (!limit.allowed) {
			logger.warn("Pairing rate limit engaged", { address, retryAfterMs: limit.retryAfterMs });
			throw new ApiError("rate_limited", "Too many pairing attempts. Try again shortly.", {
				retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000),
			});
		}

		if (!(await booleanSetting("pairing.enabled"))) {
			logger.warn("Pairing refused: pairing is switched off", { address });
			return Response.json(REJECTION, { status: 401 });
		}

		const raw = await request.text();
		if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
			throw new ApiError("body_too_large", "Pairing request is too large.");
		}

		let decoded: unknown;
		try {
			decoded = JSON.parse(raw);
		} catch {
			throw new ApiError("invalid_json", "Request body is not valid JSON.");
		}

		const parsed = pairRequestSchema.safeParse(decoded);
		if (!parsed.success) {
			throw new ApiError("missing_field", "Request body is missing required fields.");
		}

		if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
			// Refused loudly and specifically: a version mismatch is an upgrade problem the
			// operator can fix, not an attack, and a vague rejection would send them hunting
			// through the wrong logs.
			logger.warn("Pairing refused: protocol version mismatch", {
				address,
				offeredVersion: parsed.data.protocolVersion,
				serverVersion: PROTOCOL_VERSION,
			});
			throw new ApiError(
				"invalid_type",
				`This server speaks link protocol ${PROTOCOL_VERSION}; the agent offered ${parsed.data.protocolVersion}. Update the agent.`,
			);
		}

		const result = await redeemPairingCode(parsed.data.code, {
			agentVersion: parsed.data.agentVersion,
			platform: parsed.data.platform,
			hostname: parsed.data.hostname,
			address,
		});

		if (!result.ok) {
			logger.warn("Pairing refused", { address, failure: result.failure });
			return Response.json(REJECTION, { status: 401 });
		}

		// A successful pairing clears the throttle, so installing several agents in a row from
		// one workstation does not lock the installer out partway through.
		pairingLimiter.reset(address);

		logger.info("Agent paired", {
			address,
			agentId: result.grant.agentId,
			agentName: result.grant.agentName,
			hostname: parsed.data.hostname,
		});

		return Response.json(
			{
				agentId: result.grant.agentId,
				agentName: result.grant.agentName,
				token: result.grant.token,
				protocolVersion: PROTOCOL_VERSION,
			},
			{ status: 200 },
		);
	} catch (error) {
		return toErrorResponse(error, { route: "POST /api/pair", address });
	}
}
