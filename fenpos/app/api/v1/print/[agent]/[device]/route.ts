import { type ApiRouteResult, apiRoute } from "@/lib/api/api-route";
import { PRINT_REQUEST_MAX_BODY_BYTES, readBoundedJson } from "@/lib/api/bounded-body";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { bodyHash, findReplay, type IdempotentReplay, isIdempotencyKeyRace } from "@/lib/jobs/idempotency";
import { requireGrantedDevice } from "@/lib/keys/authenticate";
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
 * long as the job row exists — in practice indefinitely, since nothing sweeps this table — see
 * `lib/jobs/idempotency.ts`. A request that never became a genuinely queued job leaves its key free
 * for a corrected retry — whether it failed validation before any row existed, or was accepted and
 * then failed to compile or reach the agent (see `fail` in `lib/jobs/dispatch.ts`). Only a request
 * that actually reached `202 QUEUED` can be
 * replayed.
 *
 * **The client address is on the accepted-job line and nowhere else.** It used to be on this route's
 * error context too, which `apiRoute` now owns and a handler cannot extend. The loss was taken
 * knowingly. Restoring it would mean the wrapper reading `next/headers` itself: either once per
 * request, on a path where almost every request never faults, or inside its own `catch` — the one
 * place in the request path that must not throw, which would then need a guard swallowing whatever
 * that read did. Neither is worth one field on the fault path, and what replaced it is better
 * attribution rather than none: every fault here now leaves a durable `LogEntry` row naming the
 * key's id and name, where before there was a stdout line and nothing else. That answers "which
 * integration is failing"; only "which machine" is gone, and the accepted-job line below still
 * carries that for every job this key does get through.
 */

/** Largest `Idempotency-Key` accepted. Long enough for a UUID or an order reference, and bounded. */
const MAX_IDEMPOTENCY_KEY_CHARS = 255;

export const POST = apiRoute<{ agent: string; device: string }>(
	"api:POST /v1/print/{agent}/{device}",
	async ({ key, request, params }) => {
		const { agent, device } = params;

		// Resolved before the body is read: a caller with no grant for this device learns that
		// without the server doing any parsing work on their behalf.
		const target = await requireGrantedDevice(key, agent, device);

		const idempotencyKey = readIdempotencyKey(request);
		const { body, raw } = await readBoundedJson(request, PRINT_REQUEST_MAX_BODY_BYTES);

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
				return replayResult(replay, target, agent);
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
					return replayResult(replay, target, agent);
				}
				// The unique constraint says a row exists, but this lookup found none. The cause is `fail`
				// in `lib/jobs/dispatch.ts`, which clears a job's idempotency key the moment it settles a
				// job that never reached an agent — so a winner whose compile or send fails clears its
				// own key, and this lookup finds nothing to replay. A double-tap racing an agent
				// disconnect lands here too: one caller gets a clean `agent_offline`, and the other, us.
				// Worth a line explaining the 500 that follows rather than leaving an operator to
				// puzzle over a bare fault.
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
			address: await getClientAddress(),
		});

		return {
			// 202 rather than 201: the job is accepted and queued, and the paper has not moved yet.
			// A 201 would claim a completed print that has not happened.
			response: Response.json(
				{ jobId: job.id, status: "QUEUED", device: job.deviceName, lines: job.lines },
				{ status: 202 },
			),
			// "Queued", not "printed": the paper has not moved, and the job's own GET is where the
			// outcome eventually shows up.
			message: `Queued ${job.lines} lines for '${job.deviceName}' as job ${job.id}`,
			target: { agentId: target.agentId, agentName: agent, deviceId: target.id, deviceName: target.name },
		};
	},
);

/**
 * Builds the result for a replayed submit, sequential or raced.
 *
 * One function for both callers of it, so the two places that can decide "this is a replay" — the
 * lookup made before dispatching, and the one re-run after losing an insert race — can never drift
 * into answering the same situation two different ways.
 *
 * @param replay the original job, as {@link findReplay} resolved it
 * @param target the device the replay was addressed to, which {@link findReplay} has already
 *   matched against the original job's own device
 * @param agentName the agent named in the path, verified by the grant check that resolved `target`
 * @returns the 202 carrying the original job and the replay marker, and the line to record
 */
function replayResult(
	replay: IdempotentReplay,
	target: { id: string; name: string; agentId: string },
	agentName: string,
): ApiRouteResult {
	return {
		response: Response.json(
			{ jobId: replay.jobId, status: replay.status, device: replay.deviceName, lines: replay.lines },
			{
				status: 202,
				// A caller reconciling their own records needs to know nothing new was printed.
				// A header rather than a body field, so the body stays byte-identical to the
				// original answer and a client comparing responses sees no difference.
				headers: { "Idempotent-Replay": "true" },
			},
		),
		// Said plainly, because a replay and a fresh submit answer with the same status and nearly the
		// same body: an operator counting prints from the Logs tab would otherwise double-count one.
		message: `Replayed job ${replay.jobId} for '${replay.deviceName}'; nothing new was printed`,
		target: { agentId: target.agentId, agentName, deviceId: target.id, deviceName: target.name },
	};
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
