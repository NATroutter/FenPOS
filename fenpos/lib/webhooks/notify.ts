import "server-only";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { booleanSetting } from "@/lib/settings/settings-service";

/**
 * The columns SQLite names when `(webhook_id, job_id)` is what refused an insert.
 *
 * Mapped column names, not the Prisma field names — the driver adapter reports the constraint the
 * way the database itself describes it, and `@map` means those are not spelled the same. Mirrors
 * `lib/jobs/idempotency.ts`'s `IDEMPOTENCY_CONSTRAINT_COLUMNS`.
 */
const DELIVERY_CONSTRAINT_COLUMNS = ["webhook_id", "job_id"];

/**
 * Turning a settled job into a delivery waiting to be sent.
 *
 * **Nothing here throws.** This is called from the two paths that settle a job — the link's job
 * update handler and the dispatcher's failure path — and neither may fail because a notification
 * could not be queued. A job that printed and was not announced is a nuisance; a job update that
 * was lost because the announcement threw is a receipt whose state this server no longer knows.
 *
 * The payload is frozen at queue time. A retry minutes later must describe the job as it was when
 * it settled, and by then the row itself may be gone — cascade-deleted along with its device or
 * agent — so a payload rebuilt at each attempt would eventually be a delivery about nothing.
 */

/**
 * Queues a delivery for a job that has reached a terminal state.
 *
 * Idempotent per job, sequentially and concurrently: a second call for the same job queues
 * nothing, whether it arrives after the first has finished or races it. An agent may report a
 * terminal status twice on a reconnect, and nothing upstream of this function serialises the two
 * reports — the `findFirst` check below is the cheap common-case path, and `WebhookDelivery`'s
 * `@@unique([webhookId, jobId])` constraint is what actually guarantees one delivery per job when
 * both reports arrive together.
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
				device: { select: { name: true, agent: { select: { name: true } } } },
			},
		});

		// The job row can be gone by the time this runs — its device or agent was deleted between
		// settling and this call, cascading the job away with it. Not a fault: there is simply
		// nothing left to describe.
		if (!job || !job.apiKeyId) {
			return;
		}

		const webhook = await prisma.webhook.findFirst({
			// A revoked key's subscription must not queue a new delivery: the key stops working
			// immediately on revocation, and an operator revoking a leaked key expects notifications to
			// it to stop too, not merely new print jobs. deliverDue's due query applies the same
			// exclusion to whatever is already queued — see its module comment.
			where: { apiKeyId: job.apiKeyId, enabled: true, apiKey: { revokedAt: null } },
			select: { id: true },
		});

		if (!webhook) {
			return;
		}

		// The cheap path for the ordinary case: an agent that reports COMPLETED twice on a reconnect
		// finds its earlier delivery here and returns without touching the database again. This alone
		// is not enough to make "one settle, one delivery" true under concurrency — see the `@@unique`
		// on `WebhookDelivery` and the catch below, which is what actually enforces it.
		const existing = await prisma.webhookDelivery.findFirst({
			where: { webhookId: webhook.id, jobId: job.id },
			select: { id: true },
		});

		if (existing) {
			return;
		}

		// `at` is when this server observed the settle: the job's own `finishedAt` when the row
		// carries one, falling back to now for the rare case it does not (e.g. a row updated to a
		// terminal status without that column being set).
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
			at: (job.finishedAt ?? new Date()).toISOString(),
		});

		try {
			await prisma.webhookDelivery.create({
				data: { webhookId: webhook.id, jobId: job.id, payload },
			});
		} catch (error) {
			// Two settle reports for the same job can race past the `findFirst` check above — nothing
			// serialises frame processing on the link (see the module comment) — and the loser hits the
			// `@@unique([webhookId, jobId])` constraint that makes a *sequential* re-check safe. That is
			// success, not failure: one delivery already exists, which is exactly what this function
			// promises. Anything else is a real fault and falls through to the outer catch.
			if (!isDeliveryRace(error)) {
				throw error;
			}
		}
	} catch (error) {
		// Swallowed on purpose — see the module comment. Logged so a subscription that never fires
		// is diagnosable rather than merely silent.
		logger.error("Could not queue a webhook delivery", error, { jobId });
	}
}

/**
 * Whether a delivery insert lost a race against another settle report for the same job.
 *
 * Matched on the error code and the constraint's own columns, deliberately narrow — the same
 * discipline `lib/jobs/idempotency.ts`'s `isIdempotencyKeyRace` follows, for the same reason: a
 * broad catch on "some insert failed" would mistake an unrelated failure for a race already won by
 * someone else, and this function already has nowhere further to report a real fault except the
 * log.
 *
 * @param error the value `prisma.webhookDelivery.create` threw
 * @returns true only when this is Prisma reporting exactly the `(webhookId, jobId)` unique
 *   constraint, and not some other insert failure
 */
function isDeliveryRace(error: unknown): boolean {
	if (typeof error !== "object" || error === null || (error as { code?: unknown }).code !== "P2002") {
		return false;
	}

	const meta = (error as { meta?: unknown }).meta;
	const fields = constraintFields(meta);
	if (fields === null || fields.length !== DELIVERY_CONSTRAINT_COLUMNS.length) {
		return false;
	}

	const columns = new Set(fields);
	return DELIVERY_CONSTRAINT_COLUMNS.every((column) => columns.has(column));
}

/**
 * Reads the column names a `P2002`'s `meta` names, if it names any.
 *
 * The driver adapter used here (better-sqlite3, see `lib/db.ts`) reports them at
 * `meta.driverAdapterError.cause.constraint.fields` rather than the flatter `meta.target` some
 * other Prisma connectors use. Duplicated from `lib/jobs/idempotency.ts` rather than imported: that
 * module is about idempotency keys specifically, and importing a private helper out of it for an
 * unrelated constraint would tie the two together for no reason either will ever need.
 *
 * @param meta the `meta` field of a caught `PrismaClientKnownRequestError`
 * @returns the column names, or null when the shape does not carry any
 */
function constraintFields(meta: unknown): string[] | null {
	if (typeof meta !== "object" || meta === null) {
		return null;
	}
	const driverAdapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
	if (typeof driverAdapterError !== "object" || driverAdapterError === null) {
		return null;
	}
	const cause = (driverAdapterError as { cause?: unknown }).cause;
	if (typeof cause !== "object" || cause === null) {
		return null;
	}
	const constraint = (cause as { constraint?: unknown }).constraint;
	if (typeof constraint !== "object" || constraint === null) {
		return null;
	}
	const fields = (constraint as { fields?: unknown }).fields;
	return Array.isArray(fields) && fields.every((field) => typeof field === "string") ? (fields as string[]) : null;
}
