import "server-only";
import { prisma } from "@/lib/db";
import type { Codepage, Linefeed, UnsupportedPolicy } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import { FrameTooLargeError, MAX_FRAME_BYTES } from "@/lib/link/protocol";
import { getLink } from "@/lib/link/registry";
import { logger } from "@/lib/logger";
import {
	type CompileLimits,
	type CompileSettings,
	compile,
	type DeviceSettings,
	readRequest,
} from "@/lib/markup/compiler";
import { resolveImages } from "@/lib/markup/resolve-images";
import { resolveVariables } from "@/lib/markup/resolve-variables";
import { globalLimits, integerSetting } from "@/lib/settings/settings-service";
import { queueJobSettled } from "@/lib/webhooks/notify";

/**
 * Submitting a job: validate it, compile it, record it, hand it to the agent.
 *
 * The order matters and is not the obvious one. The job row is created **before** the frame is
 * sent, so a job that reaches an agent always has somewhere for its updates to land. Sending
 * first would open a window in which the agent reports on a job the server has no record of, and
 * those updates would be dropped — the print would happen and the panel would never know.
 *
 * The reverse risk, a row for a job that was never sent, is handled by failing the row
 * immediately with the reason, which is a state an operator can read rather than one that looks
 * like a printer taking its time.
 *
 * **Which content problems precede the row, and which do not.** Everything checked from the body
 * alone — its shape, its limits, the `variables` object, and the `<image>` fetches — is refused
 * before `job.create` runs, so those never become a job. Markup errors are not: `compile` needs the
 * job's id, and the database is what generates it, so an unknown tag, an unclosed one, a control
 * character, an unknown variable or a symbol wider than the paper can only be discovered once the
 * row is there — and each settles that row as `FAILED` with its code. This has always been true and
 * was not changed by variables; the caller gets the same refusal, with its line and column, either
 * way. Making these precede the row too means generating the id in application code first, which is
 * the same refactor the `lines: null` window below names, and it should be done for all of them at
 * once or not at all.
 */

/** A job that was accepted for printing. */
export interface SubmittedJob {
	id: string;
	deviceName: string;
	/** Printed lines after wrapping, which is what the agent will report against. */
	lines: number;
}

/**
 * Compiles and dispatches a job to the agent holding the device.
 *
 * @param deviceId the device to print on
 * @param body the request body, as parsed JSON
 * @param apiKeyId the key that submitted it, or null when it came from the panel
 * @param idempotency the caller's key and body fingerprint, recorded on the row so a retry can be
 *   recognised. Omitted by the panel and by callers that sent no header.
 * @returns the recorded job
 * @throws ApiError when the body cannot be printed, or the agent is not connected
 */
export async function submitJob(
	deviceId: string,
	body: unknown,
	apiKeyId: string | null = null,
	idempotency?: { key: string; hash: string },
): Promise<SubmittedJob> {
	const device = await prisma.device.findUnique({
		where: { id: deviceId },
		include: { agent: { select: { name: true } } },
	});

	if (!device) {
		throw new ApiError("unknown_device", "That printer no longer exists.");
	}

	if (device.paused) {
		// Checked here as well as on the agent. The agent's queue would refuse it anyway, but
		// refusing at submission gives the caller the reason immediately instead of a job that is
		// accepted, dispatched, and then fails for something the server already knew.
		throw new ApiError("device_paused", "That printer is paused.");
	}

	const deviceSettings: DeviceSettings = {
		columns: device.columns,
		codepage: device.codepage as Codepage,
		onUnsupported: device.onUnsupported as UnsupportedPolicy,
		defaultWrap: device.defaultWrap,
		defaultLinefeed: device.defaultLinefeed as Linefeed,
	};

	// Three layers, narrowest wins: a device override, then the install-wide setting, then the
	// built-in default. A device that overrides nothing follows the setting, and an install that
	// changes nothing follows the code — so improving a default improves it for everyone who never
	// touched it.
	const installed = await globalLimits();
	const limits: CompileLimits = {
		maxLines: device.maxLines ?? installed.maxLines,
		maxLineChars: device.maxLineChars ?? installed.maxLineChars,
		maxTotalChars: device.maxTotalChars ?? installed.maxTotalChars,
		maxOutputLines: device.maxOutputLines ?? installed.maxOutputLines,
	};

	const maxVariableValueChars = await integerSetting("variables.maxValueChars");

	// The body's shape and its limits, before anything is written. A request malformed at this level
	// never becomes a job. Its markup is a separate question, settled later and on a job row — see
	// this file's header.
	const request = readRequest(body, limits, deviceSettings, maxVariableValueChars);

	const link = getLink(device.agentId);
	if (!link) {
		// Refused rather than queued. Nothing on this side spools, so a job accepted now would
		// sit as QUEUED until someone noticed it never printed; saying so immediately is the
		// honest answer and the one the caller can act on.
		throw new ApiError("agent_offline", "That agent is not connected, so it cannot print.");
	}

	// Only when a key submitted the job. A print from the panel has no key to name, so it pays
	// nothing for this — and `evaluateVariable` renders the null as an empty string rather than
	// inventing a word for "nobody".
	const apiKeyName = apiKeyId
		? ((await prisma.apiKey.findUnique({ where: { id: apiKeyId }, select: { name: true } }))?.name ?? null)
		: null;

	// Variables before images, and that order is load-bearing rather than tidy: `resolveImages`
	// parses each element to find what it must fetch, and `<image>{logo}</image>` names no image
	// until this has run. Cheap enough to sit here regardless — these are database rows, while the
	// step below reaches out over the network.
	const variables = await resolveVariables({
		deviceId: device.id,
		context: { deviceName: device.name, agentName: device.agent.name, apiKeyName },
		supplied: request.variables,
	});

	// The one stage of accepting a job that waits on something outside this server: an `<image>`
	// naming a URL is fetched here, so a host that will not answer fails the submission — naming the
	// element at fault — rather than a job already recorded and sent. Still before the row exists,
	// and last among the checks that can refuse without one, so neither an oversized body nor a
	// disconnected agent costs a fetch. The markup's own errors are not in that set: they need
	// `compile`, which needs the job's id.
	const settings: CompileSettings = {
		...deviceSettings,
		variables,
		images: await resolveImages(request.data, deviceSettings.columns, variables),
	};

	const job = await prisma.job.create({
		data: {
			agentId: device.agentId,
			deviceId: device.id,
			apiKeyId,
			status: "QUEUED",
			queuedAt: new Date(),
			// Written with the row rather than after it. A key recorded in a second statement could
			// be lost to a crash between the two, and the retry that followed would print a second
			// receipt — the exact failure the key exists to prevent.
			...(idempotency ? { idempotencyKey: idempotency.key, idempotencyHash: idempotency.hash } : {}),
		},
		select: { id: true },
	});

	let compiled: ReturnType<typeof compile>;
	try {
		compiled = compile(job.id, device.name, request, limits, settings);
		// Recorded now rather than left for the agent's eventual report. The count is real the
		// moment compilation succeeds — it is the same number this call is about to hand back in
		// the 202 — and a caller who retries before anything has rendered still needs a replay
		// that reproduces that number, not a `lines: null` that contradicts the receipt they were
		// already given. A second write rather than folded into the row's own `create` because
		// `compile` needs the job's id, which only exists once that row does. That does leave the row
		// briefly visible with `lines` null between the insert above and this write, and it is not
		// only the raced insert (`isIdempotencyKeyRace`) that can observe it: a plain in-flight retry
		// hitting the ordinary `findReplay` lookup in that window gets the same `lines: null`. Fixing
		// it would need the job's id generated before `create` rather than by it, which is not worth
		// it for a window this narrow.
		await prisma.job.update({ where: { id: job.id }, data: { lines: compiled.lines.length } });
	} catch (error) {
		// Every markup content error lands here, not only the post-wrap limit: `compile` is where
		// each element is finally parsed, so `unknown_tag`, `unclosed_tag`, `control_character`,
		// `unknown_variable`, `symbol_too_wide` and `unsupported_character` all reach this handler,
		// alongside `too_many_output_lines` and a failure of the write above. What was checked before
		// the row existed is the body's shape and limits and the image fetches — not its markup. The
		// row is settled rather than deleted so the failure is visible in the panel, with the code the
		// caller was given.
		await fail(job.id, error instanceof ApiError ? error.code : "invalid_job", await message(error));
		throw error;
	}

	let sent: boolean;
	try {
		sent = link.send({ type: "job.dispatch", job: compiled });
	} catch (error) {
		// **The row exists, so nothing may leave this block without settling it.** A job recorded as
		// QUEUED that will never be sent is the most confusing state this system produces — it looks
		// like a slow printer rather than a job that will never print — and the previous version
		// reached it by enumerating error types: it settled a `FrameTooLargeError` and rethrew
		// everything else past the handler. That was not hypothetical. A single inline raster
		// between the request budget and the wire's per-raster cap threw a `ZodError` here, and a
		// job between `JOB_LIMITS.maxLines` and an operator's `maxOutputLines` throws a different
		// one. Both are properties of the request, both left the caller with a 500 and the job
		// queued forever. So the job is failed for *anything* thrown, and the shape of the error
		// only decides what the caller is told.
		await fail(job.id, sendFailureCode(error), await message(error, "Could not send."));
		if (!(error instanceof FrameTooLargeError) && !(error instanceof ApiError)) {
			// Not a shape anyone anticipated. The job is settled either way — that is the invariant —
			// but this is how the next one gets a message written for a caller instead of a stack.
			logger.error("A compiled job could not be sent", error, { jobId: job.id, agentId: device.agentId });
		}

		// An oversized frame gets a message of its own, because the caller can act on it and
		// because an agent handed one closes the link — this is the last point at which one job's
		// problem can be stopped from becoming every printer's.
		if (error instanceof FrameTooLargeError) {
			throw new ApiError(
				"job_too_large",
				`This receipt is ${error.bytes} bytes once compiled, more than the ${MAX_FRAME_BYTES} a printer can be sent in one message. Shorten it, or print its images smaller.`,
				{ bytes: error.bytes, limit: MAX_FRAME_BYTES },
				{ cause: error },
			);
		}
		throw error;
	}

	if (!sent) {
		// The socket closed between the registry lookup and the write. Ordinary on a link to a
		// shop network, and the job must not be left claiming to be queued.
		await fail(job.id, "agent_offline", "The agent disconnected before the job was sent.");
		throw new ApiError("agent_offline", "That agent disconnected. Try again once it reconnects.");
	}

	publish({
		kind: "job",
		jobId: job.id,
		status: "QUEUED",
		agentId: device.agentId,
		deviceName: device.name,
		at: new Date().toISOString(),
	});

	logger.info("Dispatched a job", {
		jobId: job.id,
		agentId: device.agentId,
		deviceName: device.name,
		lines: compiled.lines.length,
	});

	return { id: job.id, deviceName: device.name, lines: compiled.lines.length };
}

/**
 * Marks a job failed without waiting for an agent to report it.
 *
 * Every caller of this function is settling a job that never reached an agent — a compile
 * failure, a send failure, or a socket that closed before the frame went out — so the
 * idempotency key, if any, is cleared here too. Whether a refused submit frees its key must not
 * depend on which side of `job.create` the refusal fell on: a request rejected before the row
 * existed already left the key free for a corrected retry, and one rejected here needs to leave
 * it exactly as free, or a caller who fixes an oversized body and resubmits gets an
 * `idempotency_conflict` for a job that never happened, and a caller who retries the identical
 * body unmodified gets a replayed `202 QUEUED` for a job that will never print.
 *
 * @param jobId the job to settle
 * @param errorCode stable code recorded on the row
 * @param errorMessage what to show the operator
 */
async function fail(jobId: string, errorCode: string, errorMessage: string): Promise<void> {
	try {
		await prisma.job.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				finishedAt: new Date(),
				errorCode,
				errorMessage,
				idempotencyKey: null,
				idempotencyHash: null,
			},
		});

		// A job that died before reaching an agent settles here and nowhere else — the link never
		// sees it, so this is the only place that can announce it. Without this, exactly the failures
		// a caller most wants to hear about are the ones no webhook ever mentions. Inside this try for
		// symmetry with the write above it, not because queueJobSettled can throw — it never does,
		// swallowing its own faults; see its doc comment.
		await queueJobSettled(jobId);
	} catch (error) {
		logger.error("Could not record a job as failed", error, { jobId });
	}
}

/**
 * The code to record against a job that could not be handed to the link.
 *
 * `job_undeliverable` is the catch-all rather than the absence of one, and that is the point of
 * this function: the invariant is that every throw from `link.send` settles the row, so a shape
 * nobody anticipated needs a code as much as the two that were.
 *
 * @param error whatever `link.send` threw
 * @returns the code to store on the job row
 */
function sendFailureCode(error: unknown): string {
	if (error instanceof FrameTooLargeError) {
		return "job_too_large";
	}
	return error instanceof ApiError ? error.code : "job_undeliverable";
}

/**
 * The reason to record against a failed job.
 *
 * Truncated, because this is now reached by throws that were never written for a person to read —
 * a `ZodError` serialises every issue it found, and a receipt with several bad rasters produces
 * kilobytes of it. The panel shows this string in a job's row; the whole of it is in the log line
 * beside the stack.
 *
 * The truncation length is `jobs.maxErrorMessageChars`, read fresh on each call rather than
 * cached: this runs on the (already rare) failure path, not on every job, so there is no hot path
 * for a settings read to regress.
 *
 * @param error whatever was thrown
 * @param fallback what to say when it was not an `Error` at all
 * @returns a reason short enough to store and show
 */
async function message(error: unknown, fallback = "Could not compile."): Promise<string> {
	if (!(error instanceof Error)) {
		return fallback;
	}
	const maxChars = await integerSetting("jobs.maxErrorMessageChars");
	return error.message.length > maxChars ? `${error.message.slice(0, maxChars - 1)}…` : error.message;
}
