import { ApiError, toErrorResponse } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { authenticateKey, requireGrantedDevice, requirePermission } from "@/lib/keys/authenticate";
import { logger } from "@/lib/logger";
import { getClientAddress } from "@/lib/request-context";

/**
 * `POST /api/print/{agent}/{device}` — submits a job to one printer.
 *
 * The path is agent-scoped, which is the one breaking change this architecture made to the old
 * single-machine API. In exchange, device names only have to be unique *within* an agent: every
 * site can have a `kitchen` without coordinating names across the whole install, which is what
 * multi-site operators actually want.
 *
 * **Everything is decided before the response.** The body is parsed, limit-checked, wrapped to
 * the device's width and validated against its codepage, all synchronously — so a `400` names
 * the exact line, column and character at fault. Once a `202` is returned the job can only fail
 * for hardware reasons. That property is the whole point of compiling on the server, and it is
 * what makes the error contract worth reading.
 */

/** Largest body accepted. Bounded before parsing, so an oversized request costs nothing. */
const MAX_BODY_BYTES = 64 * 1024;

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

		const body = await readBody(request);
		const job = await submitJob(target.id, body, key.id);

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
		return toErrorResponse(error, { route: "POST /api/print", agent, device, address });
	}
}

/**
 * Reads and parses the request body.
 *
 * Size is checked on the raw text before parsing, because parsing is the work an oversized body
 * is trying to provoke.
 *
 * @param request the incoming request
 * @returns the parsed body
 * @throws ApiError when the body is too large or not JSON
 */
async function readBody(request: Request): Promise<unknown> {
	const raw = await request.text();

	if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
		throw new ApiError("body_too_large", `Request body must be under ${MAX_BODY_BYTES} bytes.`);
	}

	try {
		return JSON.parse(raw);
	} catch {
		throw new ApiError("invalid_json", "Body is not valid JSON");
	}
}
