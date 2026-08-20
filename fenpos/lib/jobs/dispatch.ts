import "server-only";
import { prisma } from "@/lib/db";
import type { Codepage, Linefeed, UnsupportedPolicy } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
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
import { globalLimits } from "@/lib/settings/settings-service";

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
 * Content problems are raised before any row exists at all. A request refused for bad markup
 * never becomes a job, because it never was one.
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
 * @returns the recorded job
 * @throws ApiError when the body cannot be printed, or the agent is not connected
 */
export async function submitJob(
	deviceId: string,
	body: unknown,
	apiKeyId: string | null = null,
): Promise<SubmittedJob> {
	const device = await prisma.device.findUnique({ where: { id: deviceId } });

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

	// Validated before anything is written. A request that cannot be printed never becomes a
	// job, so the job table is a record of work that was genuinely accepted.
	const request = readRequest(body, limits, deviceSettings);

	const link = getLink(device.agentId);
	if (!link) {
		// Refused rather than queued. Nothing on this side spools, so a job accepted now would
		// sit as QUEUED until someone noticed it never printed; saying so immediately is the
		// honest answer and the one the caller can act on.
		throw new ApiError("agent_offline", "That agent is not connected, so it cannot print.");
	}

	// The one stage of accepting a job that waits on something outside this server: an `<image>`
	// naming a URL is fetched here, so a host that will not answer fails the submission — naming the
	// element at fault — rather than a job already recorded and sent. Still before the row
	// exists, like every other content problem, and last among the checks that can refuse without
	// one, so neither an oversized body nor a disconnected agent costs a fetch.
	const settings: CompileSettings = { ...deviceSettings, images: await resolveImages(request.data) };

	const job = await prisma.job.create({
		data: {
			agentId: device.agentId,
			deviceId: device.id,
			apiKeyId,
			status: "QUEUED",
			queuedAt: new Date(),
		},
		select: { id: true },
	});

	let compiled: ReturnType<typeof compile>;
	try {
		compiled = compile(job.id, device.name, request, limits, settings);
	} catch (error) {
		// Only the post-wrap limit can fail here; everything cheaper was checked before the row
		// existed. The row is settled rather than deleted so the failure is visible in the panel.
		await fail(job.id, error instanceof ApiError ? error.code : "invalid_job", message(error));
		throw error;
	}

	if (!link.send({ type: "job.dispatch", job: compiled })) {
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
 * @param jobId the job to settle
 * @param errorCode stable code recorded on the row
 * @param errorMessage what to show the operator
 */
async function fail(jobId: string, errorCode: string, errorMessage: string): Promise<void> {
	try {
		await prisma.job.update({
			where: { id: jobId },
			data: { status: "FAILED", finishedAt: new Date(), errorCode, errorMessage },
		});
	} catch (error) {
		logger.error("Could not record a job as failed", error, { jobId });
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : "Could not compile.";
}
