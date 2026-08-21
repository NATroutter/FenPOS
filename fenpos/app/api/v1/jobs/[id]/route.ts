import { prisma } from "@/lib/db";
import { isTerminalJobStatus, JobStatus } from "@/lib/domain/enums";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { authenticateKey, requirePermission } from "@/lib/keys/authenticate";
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
 * only thing a caller guessing identifiers is trying to learn.
 */

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await context.params;

	try {
		const key = await authenticateKey(request);
		requirePermission(key, "jobs:read");

		const job = await prisma.job.findFirst({
			where: { id, apiKeyId: key.id },
			select: {
				id: true,
				status: true,
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

		return Response.json({
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
		});
	} catch (error) {
		return toErrorResponse(error, { route: "GET /api/v1/jobs/[id]", jobId: id });
	}
}

/**
 * Cancels a job that has not started printing.
 *
 * Cancellation is a request to the agent, not a fact the server can assert. Only the machine
 * holding the printer knows whether the job is still waiting or already halfway through the
 * paper, and a server that marked it cancelled regardless would report a receipt as withdrawn
 * while it was being handed to a customer.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await context.params;

	try {
		const key = await authenticateKey(request);
		requirePermission(key, "jobs:cancel");

		const job = await prisma.job.findFirst({
			where: { id, apiKeyId: key.id },
			select: { id: true, status: true, agentId: true },
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

		// 202: the request has been passed on, and the job's final state arrives from the agent.
		return Response.json({ jobId: job.id, status: "CANCELLING" }, { status: 202 });
	} catch (error) {
		return toErrorResponse(error, { route: "DELETE /api/v1/jobs/[id]", jobId: id });
	}
}
