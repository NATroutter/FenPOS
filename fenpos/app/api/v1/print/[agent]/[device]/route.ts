import { ApiError, toErrorResponse } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { bodyHash, findReplay, type IdempotentReplay, isIdempotencyKeyRace } from "@/lib/jobs/idempotency";
import { authenticateKey, requireGrantedDevice, requirePermission } from "@/lib/keys/authenticate";
import { logger } from "@/lib/logger";
import { getClientAddress } from "@/lib/request-context";

/**
 * `POST /api/v1/print/{agent}/{device}` — submits a job to one printer.
 *
 * The path is agent-scoped, which is the one breaking change this architecture made to the old
 * single-machine API. In exchange, device names only have to be unique *within* an agent: every
 * site can have a `kitchen` without coordinating names across the whole install, which is what
 * multi-site operators actually want.
 *
 * **Everything about the request is decided before the response.** The body is parsed, limit-checked,
 * wrapped to the device's width and validated against its codepage, all synchronously — so a `422`
 * names the exact line, column and character at fault. Once a `202` is returned, the job is still
 * not guaranteed to print: the agent re-checks the dispatch against its own device set and renders
 * the job itself, and either of those can fail there independently of the hardware, which can of
 * course fail too. None of that reaches this response — it reaches the caller as `error` and
 * `errorMessage` on the job's own GET. That the request itself is fully settled synchronously is
 * still the whole point of compiling on the server, and it is what makes the error contract worth
 * reading.
 *
 * **An `Idempotency-Key` header makes a retry safe.** A repeated key addressed to the same device
 * with the same body replays the original answer and prints nothing; the same body addressed to a
 * *different* device, or a different body, is refused as a conflict. The key is replayable for as
 * long as the job row survives retention — see `lib/jobs/idempotency.ts`. A request that never
 * became a genuinely queued job leaves its key free for a corrected retry — whether it failed
 * validation before any row existed, or was accepted and then failed to compile or reach the agent
 * (see `fail` in `lib/jobs/dispatch.ts`). Only a request that actually reached `202 QUEUED` can be
 * replayed.
 */

/** Largest body accepted. Bounded before parsing, so an oversized request costs nothing. */
const MAX_BODY_BYTES = 64 * 1024;

/** Largest `Idempotency-Key` accepted. Long enough for a UUID or an order reference, and bounded. */
const MAX_IDEMPOTENCY_KEY_CHARS = 255;

export async function POST(
	request: Request,
	context: { params: Promise<{ agent: string; device: string }> },
): Promise<Response> {
	const { agent, device } = await context.params;
	const address = await getClientAddress();

	try {
		const key = await authenticateKey(request);
		requirePermission(key, "print");

		// Resolved before the body is read: a caller with no grant for this device learns that
		// without the server doing any parsing work on their behalf.
		const target = await requireGrantedDevice(key, agent, device);

		const idempotencyKey = readIdempotencyKey(request);
		const { body, raw } = await readBody(request);

		// Checked after the body is read, because the answer depends on the body: a repeated key
		// with different content is a conflict rather than a replay, and that cannot be known until
		// there is something to fingerprint.
		const idempotency = idempotencyKey === null ? undefined : { key: idempotencyKey, hash: bodyHash(raw) };
		if (idempotency) {
			const replay = await findReplay(key.id, idempotency.key, idempotency.hash, target.id);
			if (replay) {
				logger.info("Replayed an idempotent submit", {
					jobId: replay.jobId,
					keyId: key.id,
					idempotencyKey: idempotency.key,
				});
				return replayResponse(replay);
			}
		}

		let job: Awaited<ReturnType<typeof submitJob>>;
		try {
			job = await submitJob(target.id, body, key.id, idempotency);
		} catch (error) {
			// Two requests can carry the same key at once — a double-tap, or a client retrying the
			// instant it times out. Both reach here finding nothing to replay, and both insert; the
			// loser hits the unique constraint that makes a *sequential* retry safe. Answered by
			// re-running the same lookup rather than left to surface as an opaque fault: by now the
			// winner's row exists, so this resolves exactly as a retry arriving a moment later would
			// — same hash replays it, different hash raises `idempotency_conflict` — and the caller
			// can never tell which way it fell.
			if (idempotency && isIdempotencyKeyRace(error)) {
				const replay = await findReplay(key.id, idempotency.key, idempotency.hash, target.id);
				if (replay) {
					logger.info("Replayed an idempotent submit after losing a concurrent race", {
						jobId: replay.jobId,
						keyId: key.id,
						idempotencyKey: idempotency.key,
					});
					return replayResponse(replay);
				}
				// The unique constraint says a row exists, but this lookup found none — the winner's
				// row must have been removed (e.g. by retention) in the narrow window between the
				// failed insert and this re-check. Vanishingly unlikely, and worth a line explaining
				// the 500 that follows rather than leaving an operator to puzzle over a bare fault.
				logger.warn("Lost an idempotency-key insert race but found no row to replay", {
					keyId: key.id,
					idempotencyKey: idempotency.key,
					deviceId: target.id,
				});
			}
			throw error;
		}

		logger.info("Job accepted", {
			jobId: job.id,
			keyId: key.id,
			agentName: agent,
			deviceName: device,
			lines: job.lines,
			address,
		});

		// 202 rather than 201: the job is accepted and queued, and the paper has not moved yet.
		// A 201 would claim a completed print that has not happened.
		return Response.json(
			{ jobId: job.id, status: "QUEUED", device: job.deviceName, lines: job.lines },
			{ status: 202 },
		);
	} catch (error) {
		return toErrorResponse(error, { route: "POST /api/v1/print", agent, device, address });
	}
}

/**
 * Builds the response for a replayed submit, sequential or raced.
 *
 * One function for both callers of it, so the two places that can decide "this is a replay" — the
 * lookup made before dispatching, and the one re-run after losing an insert race — can never drift
 * into answering the same situation two different ways.
 *
 * @param replay the original job, as {@link findReplay} resolved it
 * @returns the 202 response carrying the original job and the replay marker
 */
function replayResponse(replay: IdempotentReplay): Response {
	return Response.json(
		{ jobId: replay.jobId, status: replay.status, device: replay.deviceName, lines: replay.lines },
		{
			status: 202,
			// A caller reconciling their own records needs to know nothing new was printed.
			// A header rather than a body field, so the body stays byte-identical to the
			// original answer and a client comparing responses sees no difference.
			headers: { "Idempotent-Replay": "true" },
		},
	);
}

/**
 * Reads the caller's idempotency key, if they sent one.
 *
 * Bounded, because it is stored and indexed. An unbounded header would let a caller write arbitrary
 * strings into the job table one request at a time. A header present but empty, or all whitespace,
 * is refused rather than treated as absent: a caller who sent it believes they are protected, and
 * silently granting no protection would leave them believing that until a retry actually printed
 * twice.
 *
 * @param request the incoming request
 * @returns the key, or null when the header is absent entirely
 * @throws ApiError when the header is present but empty, or longer than
 *   {@link MAX_IDEMPOTENCY_KEY_CHARS}
 */
function readIdempotencyKey(request: Request): string | null {
	const header = request.headers.get("idempotency-key");
	if (header === null) {
		return null;
	}
	const raw = header.trim();
	if (!raw) {
		throw new ApiError("invalid_type", "Idempotency-Key must not be empty.");
	}
	if (raw.length > MAX_IDEMPOTENCY_KEY_CHARS) {
		throw new ApiError("invalid_type", `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters.`);
	}
	return raw;
}

/**
 * Reads and parses the request body, keeping the raw text.
 *
 * Size is checked on the raw text before parsing, because parsing is the work an oversized body
 * is trying to provoke. The text is returned alongside the parsed value because the idempotency
 * fingerprint is taken over the bytes as they arrived rather than over a re-serialised object —
 * see `bodyHash`.
 *
 * @param request the incoming request
 * @returns the parsed body and the text it was parsed from
 * @throws ApiError when the body is too large or not JSON
 */
async function readBody(request: Request): Promise<{ body: unknown; raw: string }> {
	const raw = await request.text();

	if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
		throw new ApiError("body_too_large", `Request body must be under ${MAX_BODY_BYTES} bytes.`);
	}

	try {
		return { body: JSON.parse(raw), raw };
	} catch {
		throw new ApiError("invalid_json", "Body is not valid JSON");
	}
}
