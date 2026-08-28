import { apiRoute } from "@/lib/api/api-route";
import { prisma } from "@/lib/db";
import { isTerminalJobStatus, JobStatus } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { getLink } from "@/lib/link/registry";
import { logger } from "@/lib/logger";

/**
 * `GET /api/v1/jobs/{id}` and `DELETE /api/v1/jobs/{id}` — reading and cancelling one job.
 *
 * **A key can only see the jobs it submitted.** Scoping to the key rather than to the device is
 * the stricter of the two and the right one: two systems sharing a printer should not be able to
 * read each other's receipts, which carry customer orders and totals.
 *
 * A job belonging to another key is reported as unknown rather than forbidden, for the same
 * reason a device is: distinguishing them would confirm that an identifier exists, which is the
 * only thing a caller guessing identifiers is trying to learn. That is why `unknown_job` is
 * recorded as a refusal rather than as a failure — see `levelFor` in `lib/api/request-log.ts`,
 * which classifies it beside `unknown_device` on exactly this argument.
 */

export const GET = apiRoute<{ id: string }>("api:GET /v1/jobs/{id}", async ({ key, params }) => {
	const job = await prisma.job.findFirst({
		where: { id: params.id, apiKeyId: key.id },
		select: {
			id: true,
			status: true,
			agentId: true,
			deviceId: true,
			submittedAt: true,
			queuedAt: true,
			startedAt: true,
			finishedAt: true,
			lines: true,
			bytes: true,
			errorCode: true,
			errorMessage: true,
			device: { select: { name: true, agent: { select: { name: true } } } },
		},
	});

	if (!job) {
		throw new ApiError("unknown_job", "No such job.");
	}

	return {
		response: Response.json({
			jobId: job.id,
			status: job.status,
			agent: job.device.agent.name,
			device: job.device.name,
			submittedAt: job.submittedAt.toISOString(),
			queuedAt: job.queuedAt?.toISOString() ?? null,
			startedAt: job.startedAt?.toISOString() ?? null,
			finishedAt: job.finishedAt?.toISOString() ?? null,
			lines: job.lines,
			bytes: job.bytes,
			error: job.errorCode,
			errorMessage: job.errorMessage,
		}),
		message: `Read job ${job.id}, which is ${job.status}`,
		// The ids as well as the names: the Logs tab's agent filter and its live stream read the id,
		// and the names are what the row still says once the device is deleted. Both were already
		// being selected or are scalar columns on the row, so naming them costs no extra query.
		target: {
			agentId: job.agentId,
			agentName: job.device.agent.name,
			deviceId: job.deviceId,
			deviceName: job.device.name,
		},
	};
});

/**
 * Cancels a job that has not started printing.
 *
 * Cancellation is a request to the agent, not a fact the server can assert. Only the machine
 * holding the printer knows whether the job is still waiting or already halfway through the
 * paper, and a server that marked it cancelled regardless would report a receipt as withdrawn
 * while it was being handed to a customer.
 */
export const DELETE = apiRoute<{ id: string }>("api:DELETE /v1/jobs/{id}", async ({ key, params }) => {
	const job = await prisma.job.findFirst({
		where: { id: params.id, apiKeyId: key.id },
		// The device and agent names are read for the log line alone. A cancellation is a command, so
		// its row is always kept, and a row an operator cannot tie to a printer is one they have to
		// open the job to understand.
		select: {
			id: true,
			status: true,
			agentId: true,
			deviceId: true,
			device: { select: { name: true, agent: { select: { name: true } } } },
		},
	});

	if (!job) {
		throw new ApiError("unknown_job", "No such job.");
	}

	if (JobStatus.is(job.status) && isTerminalJobStatus(job.status)) {
		throw new ApiError("job_not_cancellable", `That job is already ${job.status.toLowerCase()}.`);
	}

	const link = getLink(job.agentId);
	if (!link) {
		throw new ApiError("agent_offline", "That agent is not connected, so the job cannot be cancelled right now.");
	}

	// The agent reports the outcome as a job update, which is what actually settles the row.
	// Nothing is written here: claiming the cancellation succeeded before the agent has said
	// so would be the server asserting something only the printer knows.
	if (!link.send({ type: "job.cancel", jobId: job.id })) {
		throw new ApiError("agent_offline", "That agent disconnected before the request was sent.");
	}

	logger.info("Job cancellation requested", { jobId: job.id, keyId: key.id });

	return {
		// 202: the request has been passed on, and the job's final state arrives from the agent.
		response: Response.json({ jobId: job.id, status: "CANCELLING" }, { status: 202 }),
		// "Asked", not "cancelled": the agent decides, and this line must not claim otherwise.
		message: `Asked '${job.device.agent.name}' to cancel job ${job.id} on '${job.device.name}'`,
		target: {
			agentId: job.agentId,
			agentName: job.device.agent.name,
			deviceId: job.deviceId,
			deviceName: job.device.name,
		},
	};
});
