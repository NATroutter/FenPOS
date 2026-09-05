import { z } from "zod";
import { redeemPairingCode } from "@/lib/agents/pairing";
import { readBoundedText } from "@/lib/api/bounded-body";
import { pairingFloodLimiter, pairingLimiter } from "@/lib/auth/rate-limit";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { PROTOCOL_VERSION } from "@/lib/link/protocol";
import { logger } from "@/lib/logger";
import { getClientAddress, getPeerAddress } from "@/lib/request-context";
import { booleanSetting } from "@/lib/settings/settings-service";

/**
 * `POST /api/pair` — exchanges a pairing code for a agent credential.
 *
 * The only unauthenticated write in the system. Everything about it is shaped by that:
 *
 * - Rate limited twice. `pairingFloodLimiter` is consumed first, on the connection's own peer,
 *   before any settings are read — resolving the client address costs a query, and a request
 *   this endpoint is about to refuse must not cost one first. Only a caller past that gate has
 *   its client address resolved and spends against `pairingLimiter`, the tight budget the code's
 *   entropy actually assumes. Keying the tight budget on the peer instead would have been cheaper
 *   still, but every caller behind one reverse proxy shares a peer, so it would also mean one
 *   hostile caller spending every other caller's guesses. Both limiters are consumed
 *   unconditionally, before `pairing.enabled` is even read — see that check's own comment below
 *   for why the ordering there is deliberate rather than an oversight.
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
	// The peer, not the resolved address: this keys the flood limiter below, and reading the
	// trusted-proxy settings first would mean a database query on every request that limiter is
	// about to refuse. The resolved address is read afterwards, once it is safe to pay for it.
	const peer = await getPeerAddress();
	// Overwritten below once it is safe to spend a settings read; kept as the peer until then so
	// an error thrown before that point still has something honest to log.
	let address = peer;

	try {
		// Both limiters are consumed unconditionally — before any settings are read, before the
		// body is read and before `pairing.enabled` is even checked. Checking `pairing.enabled`
		// first would be cheaper, but it would also mean a limiter's state does not advance while
		// pairing is off, and a caller who sends a flood of requests would see the request that
		// exhausts it answered differently depending on whether pairing is on (429 rate_limited) or
		// off (401, forever, since the limiter was never touched) — a volume-based oracle for "is
		// this install worth attacking" that needs no correct code at all. That is just as true of
		// the tight limiter as it was when it was the only one: consuming it only while pairing is
		// on would move the oracle from the flood limiter's threshold to the tight limiter's,
		// rather than removing it. Consuming both here first, in order, keeps each limiter's state —
		// and so the endpoint's behaviour under volume — identical whether pairing is on or off. Do
		// not "optimise" this back.
		const flood = pairingFloodLimiter.consume(peer);
		if (!flood.allowed) {
			logger.warn("Pairing flood limit engaged", { address: peer, retryAfterMs: flood.retryAfterMs });
			throw new ApiError("rate_limited", "Too many pairing attempts. Try again shortly.", {
				retryAfterSeconds: Math.ceil(flood.retryAfterMs / 1000),
			});
		}

		// Past the flood gate, so the query this costs is one a caller cannot make for free. Used
		// for the log lines and the pairing record, where an install behind a proxy wants the
		// address the proxy names rather than the proxy's own — and now also to key the tight
		// limiter below, so that address, not the shared peer, is what a guess spends against.
		address = await getClientAddress();

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

		// Bounded on the way in rather than measured afterwards. This is the one unauthenticated write
		// in the system, so a body it is going to refuse must never be a body it first holds — reading
		// the text and then comparing its length answered 413 only after every byte had been received
		// and stringified, which made the refusal cost far more than the request.
		const raw = await readBoundedText(request, MAX_BODY_BYTES, "Pairing request is too large.");

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

		// A successful pairing clears the tight throttle for this address, so installing several
		// agents in a row from one workstation does not lock the installer out partway through.
		// The flood limiter is left alone: it is keyed on the shared peer, not this one caller, and
		// resetting a shared budget on any single success would let a caller spend part of it
		// guessing, then ride someone else's successful pairing — or one of its own, once it lands
		// a correct guess — back to a full sixty rather than actually paying for the floor it is
		// meant to be.
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
