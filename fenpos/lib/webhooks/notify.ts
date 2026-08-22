import "server-only";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { booleanSetting } from "@/lib/settings/settings-service";

/**
 * Turning a settled job into a delivery waiting to be sent.
 *
 * **Nothing here throws.** This is called from the two paths that settle a job — the link's job
 * update handler and the dispatcher's failure path — and neither may fail because a notification
 * could not be queued. A job that printed and was not announced is a nuisance; a job update that
 * was lost because the announcement threw is a receipt whose state this server no longer knows.
 *
 * The payload is frozen at queue time. A retry minutes later must describe the job as it was when
 * it settled, and by then retention may have deleted the row entirely — a payload rebuilt at each
 * attempt would eventually be a delivery about nothing.
 */

/**
 * Queues a delivery for a job that has reached a terminal state.
 *
 * Idempotent per job: a second call for the same job queues nothing, so an agent that reports a
 * terminal status twice — which it may, on a reconnect — does not notify twice.
 *
 * @param jobId the job that settled
 */
export async function queueJobSettled(jobId: string): Promise<void> {
	try {
		if (!(await booleanSetting("webhooks.enabled"))) {
			return;
		}

		const job = await prisma.job.findUnique({
			where: { id: jobId },
			select: {
				id: true,
				status: true,
				apiKeyId: true,
				lines: true,
				bytes: true,
				errorCode: true,
				errorMessage: true,
				finishedAt: true,
				submittedAt: true,
				device: { select: { name: true, agent: { select: { name: true } } } },
			},
		});

		// Swept by retention between settling and this call. Ordinary on a busy install with a short
		// window, and not a fault: there is simply nothing left to describe.
		if (!job || !job.apiKeyId) {
			return;
		}

		const webhook = await prisma.webhook.findFirst({
			where: { apiKeyId: job.apiKeyId, enabled: true },
			select: { id: true },
		});

		if (!webhook) {
			return;
		}

		// One delivery per job. An agent that reports COMPLETED twice — which happens on a reconnect
		// that replays its outbox — must not produce two notifications for one receipt.
		const existing = await prisma.webhookDelivery.findFirst({
			where: { webhookId: webhook.id, jobId: job.id },
			select: { id: true },
		});

		if (existing) {
			return;
		}

		const payload = JSON.stringify({
			event: "job.settled",
			jobId: job.id,
			status: job.status,
			agent: job.device.agent.name,
			device: job.device.name,
			lines: job.lines,
			bytes: job.bytes,
			error: job.errorCode,
			errorMessage: job.errorMessage,
			submittedAt: job.submittedAt.toISOString(),
			finishedAt: job.finishedAt?.toISOString() ?? null,
		});

		await prisma.webhookDelivery.create({
			data: { webhookId: webhook.id, jobId: job.id, payload },
		});
	} catch (error) {
		// Swallowed on purpose — see the module comment. Logged so a subscription that never fires
		// is diagnosable rather than merely silent.
		logger.error("Could not queue a webhook delivery", error, { jobId });
	}
}
