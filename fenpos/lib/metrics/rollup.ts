import type { PrismaClient } from "@/generated/prisma/client";
import type { PrismaClient as AuditPrismaClient } from "@/generated/prisma-audit/client";
import type { PrismaClient as MetricsPrismaClient } from "@/generated/prisma-metrics/client";
import { computeJobRollup, type RollupJobInput } from "@/lib/metrics/rollup-jobs";

/**
 * Rolls raw per-event tables (jobs, webhook deliveries, audit events) into the hourly summary
 * tables the panel charts read from.
 *
 * Clients arrive as parameters rather than being imported from `@/lib/db`: this module has no
 * `server-only` guard and is called directly by the seed script, which runs as plain node outside
 * the Next.js request lifecycle.
 */

export interface RollupClients {
	db: PrismaClient;
	metricsDb: MetricsPrismaClient;
	/** Null skips the audit stream entirely — no watermark read, no rows rolled. */
	auditDb: AuditPrismaClient | null;
}

/** Hours behind the watermark re-rolled every pass, absorbing late agent settle reports. */
export const REROLL_HOURS = 26;

const HOUR_MS = 60 * 60 * 1000;

/** Truncates a timestamp to the start of its UTC hour. */
export function hourStart(date: Date): Date {
	return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

type StreamName = "jobs" | "webhooks" | "audit";

/**
 * Rolls one stream: reads (or derives) its watermark, replays every hour from the later of the
 * watermark and the backfill start through the trailing re-roll window, then advances the
 * watermark to `currentHour`.
 *
 * @param findBackfillStart - resolves the earliest hour worth rolling when no watermark exists
 *   yet, by looking at the source table's oldest row; `null` means the source table is empty
 * @param rollHour - rolls a single hour for this stream (delete-then-create, always run so a
 *   removed source row disappears on re-roll)
 * @returns the number of hours rolled
 */
async function rollStream(
	clients: RollupClients,
	stream: StreamName,
	currentHour: Date,
	rollHour: (clients: RollupClients, bucket: Date) => Promise<void>,
	findBackfillStart: () => Promise<Date | null>,
): Promise<number> {
	const existing = await clients.metricsDb.metricWatermark.findUnique({ where: { stream } });

	let watermark: Date;
	if (existing) {
		watermark = existing.rolledThrough;
	} else {
		const backfillStart = await findBackfillStart();
		if (backfillStart === null) {
			// Nothing to roll yet; park the watermark at the current hour so a later run starts
			// from real data rather than replaying an empty history.
			await clients.metricsDb.metricWatermark.upsert({
				where: { stream },
				update: { rolledThrough: currentHour },
				create: { stream, rolledThrough: currentHour },
			});
			return 0;
		}
		watermark = backfillStart;
	}

	const reRollFrom = new Date(currentHour.getTime() - REROLL_HOURS * HOUR_MS);
	const from = watermark.getTime() < reRollFrom.getTime() ? watermark : reRollFrom;

	let rolledHours = 0;
	for (let bucket = from; bucket.getTime() < currentHour.getTime(); bucket = new Date(bucket.getTime() + HOUR_MS)) {
		await rollHour(clients, bucket);
		rolledHours += 1;
	}

	await clients.metricsDb.metricWatermark.upsert({
		where: { stream },
		update: { rolledThrough: currentHour },
		create: { stream, rolledThrough: currentHour },
	});

	return rolledHours;
}

/**
 * Rolls every stream up to (but never including) the current, incomplete hour.
 *
 * @param now - defaults to the real clock; overridable for tests and backfills
 * @returns the total number of stream-hours rolled across jobs, webhooks and (when `auditDb` is
 *   present) audit
 */
export async function runMetricsRollup(clients: RollupClients, now = new Date()): Promise<{ rolledHours: number }> {
	const currentHour = hourStart(now);
	let rolledHours = 0;

	rolledHours += await rollStream(clients, "jobs", currentHour, rollJobsHour, async () => {
		const first = await clients.db.job.findFirst({ orderBy: { submittedAt: "asc" }, select: { submittedAt: true } });
		return first ? hourStart(first.submittedAt) : null;
	});

	rolledHours += await rollStream(clients, "webhooks", currentHour, rollWebhooksHour, async () => {
		const first = await clients.db.webhookDelivery.findFirst({
			orderBy: { createdAt: "asc" },
			select: { createdAt: true },
		});
		return first ? hourStart(first.createdAt) : null;
	});

	if (clients.auditDb) {
		rolledHours += await rollStream(clients, "audit", currentHour, rollAuditHour, async () => {
			const first = await clients.auditDb?.auditEvent.findFirst({ orderBy: { at: "asc" }, select: { at: true } });
			return first ? hourStart(first.at) : null;
		});
	}

	return { rolledHours };
}

/**
 * Rolls one hour of terminal jobs into `MetricJobHourly`/`MetricErrorHourly`.
 *
 * A job counts against `finishedAt` when it has one; a terminal job somehow missing `finishedAt`
 * falls back to `submittedAt` so it is never silently dropped from every rollup pass forever.
 */
async function rollJobsHour(clients: RollupClients, bucket: Date): Promise<void> {
	const bucketEnd = new Date(bucket.getTime() + HOUR_MS);

	const jobs = await clients.db.job.findMany({
		where: {
			status: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
			OR: [
				{ finishedAt: { gte: bucket, lt: bucketEnd } },
				{ finishedAt: null, submittedAt: { gte: bucket, lt: bucketEnd } },
			],
		},
		include: {
			device: { select: { name: true } },
			agent: { select: { name: true } },
		},
	});

	const inputs: RollupJobInput[] = jobs.map((job) => ({
		deviceId: job.deviceId,
		agentId: job.agentId,
		deviceName: job.device.name,
		agentName: job.agent.name,
		status: job.status,
		submittedAt: job.submittedAt,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		bytes: job.bytes,
		lines: job.lines,
		apiKeyId: job.apiKeyId,
		errorCode: job.errorCode,
	}));

	const { jobRows, errorRows } = computeJobRollup(bucket, inputs);

	await clients.metricsDb.$transaction([
		clients.metricsDb.metricJobHourly.deleteMany({ where: { bucket } }),
		clients.metricsDb.metricErrorHourly.deleteMany({ where: { bucket } }),
		...(jobRows.length > 0 ? [clients.metricsDb.metricJobHourly.createMany({ data: jobRows })] : []),
		...(errorRows.length > 0 ? [clients.metricsDb.metricErrorHourly.createMany({ data: errorRows })] : []),
	]);
}

/**
 * Rolls one hour of webhook deliveries into `MetricWebhookHourly`.
 *
 * The delivery table has no relation back to jobs, only to webhooks, and a delivery whose webhook
 * was since deleted keeps its id but resolves to no name — those deliveries are reported under
 * `webhookName: "(deleted)"` rather than dropped, so the hour's totals still add up.
 *
 * **Skips the rewrite when the raw rows are gone but the hour was already rolled.** `webhookDelivery`
 * is pruned by a *count* cap, not an age cap — {@link sweepDeliveriesNow} in `lib/webhooks/deliver.ts`
 * deletes the oldest settled rows once the table exceeds `webhooks.maxDeliveryRecords`, with no regard
 * for how recent they are. On a busy install that cap can be reached inside the {@link REROLL_HOURS}
 * trailing window this function replays every pass, so an hour this function already rolled correctly
 * can, on a later pass, find zero raw rows for a bucket it has real rolled data for. Rolling that as
 * "zero deliveries" and deleting the existing `MetricWebhookHourly` rows would erase real history
 * under the same count-capped sweep that rollups exist to survive, and a rollup, once written, is
 * meant to be permanent. So: three empty raw queries plus an existing rolled row for the
 * bucket means "already rolled, raw rows since swept," and the existing rows are left untouched rather
 * than replaced with nothing. Three empty raw queries with *no* existing rolled row is the ordinary
 * "genuinely nothing happened this hour" case, and still rolls (to an empty transaction, same as
 * today) so a watermark advances over a quiet hour exactly as before.
 */
async function rollWebhooksHour(clients: RollupClients, bucket: Date): Promise<void> {
	const bucketEnd = new Date(bucket.getTime() + HOUR_MS);

	const [created, delivered, failed, webhooks] = await Promise.all([
		clients.db.webhookDelivery.findMany({
			where: { createdAt: { gte: bucket, lt: bucketEnd } },
			select: { webhookId: true, attempts: true },
		}),
		clients.db.webhookDelivery.findMany({
			where: { deliveredAt: { gte: bucket, lt: bucketEnd } },
			select: { webhookId: true },
		}),
		clients.db.webhookDelivery.findMany({
			where: { status: "FAILED", nextAttemptAt: { gte: bucket, lt: bucketEnd } },
			select: { webhookId: true },
		}),
		clients.db.webhook.findMany({ select: { id: true, apiKey: { select: { name: true } } } }),
	]);

	// Webhook itself has no name column; it is named after the one API key it belongs to
	// (`apiKeyId` is unique — one webhook per key). Deleting that key cascades to the webhook
	// row, so a delivery whose webhook has vanished simply finds nothing in this map.
	const names = new Map(webhooks.map((w) => [w.id, w.apiKey.name]));

	interface Acc {
		queued: number;
		delivered: number;
		failed: number;
		attemptsSum: number;
		attemptsMax: number;
	}
	const byWebhook = new Map<string, Acc>();
	function acc(webhookId: string): Acc {
		let a = byWebhook.get(webhookId);
		if (!a) {
			a = { queued: 0, delivered: 0, failed: 0, attemptsSum: 0, attemptsMax: 0 };
			byWebhook.set(webhookId, a);
		}
		return a;
	}

	for (const d of created) {
		const a = acc(d.webhookId);
		a.queued += 1;
		a.attemptsSum += d.attempts;
		a.attemptsMax = Math.max(a.attemptsMax, d.attempts);
	}
	for (const d of delivered) {
		acc(d.webhookId).delivered += 1;
	}
	for (const d of failed) {
		acc(d.webhookId).failed += 1;
	}

	const rows = [...byWebhook.entries()].map(([webhookId, a]) => ({
		bucket,
		webhookId,
		webhookName: names.get(webhookId) ?? "(deleted)",
		queued: a.queued,
		delivered: a.delivered,
		failed: a.failed,
		attemptsSum: a.attemptsSum,
		attemptsMax: a.attemptsMax,
	}));

	if (created.length === 0 && delivered.length === 0 && failed.length === 0) {
		const alreadyRolled = await clients.metricsDb.metricWebhookHourly.count({ where: { bucket } });
		if (alreadyRolled > 0) {
			// See the doc comment above: the count-capped sweep, not a genuinely quiet hour, is the
			// likely reason all three raw queries came back empty. Leave the existing rolled rows in
			// place rather than rewriting them away.
			return;
		}
	}

	await clients.metricsDb.$transaction([
		clients.metricsDb.metricWebhookHourly.deleteMany({ where: { bucket } }),
		...(rows.length > 0 ? [clients.metricsDb.metricWebhookHourly.createMany({ data: rows })] : []),
	]);
}

/**
 * Rolls one hour of audit events into `MetricAuthHourly` under `category:<prefix>` kinds.
 *
 * Only rows whose `kind` starts with `category:` are ever deleted or rewritten here: the other
 * kinds in this table (signin_success, rate_limited, ...) are live counters written elsewhere, and
 * this stream must never touch them.
 */
async function rollAuditHour(clients: RollupClients, bucket: Date): Promise<void> {
	const auditDb = clients.auditDb;
	if (!auditDb) return;

	const bucketEnd = new Date(bucket.getTime() + HOUR_MS);

	const events = await auditDb.auditEvent.findMany({
		where: { at: { gte: bucket, lt: bucketEnd } },
		select: { action: true },
	});

	const counts = new Map<string, number>();
	for (const event of events) {
		const kind = `category:${event.action.split(":")[0]}`;
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}

	const rows = [...counts.entries()].map(([kind, count]) => ({ bucket, kind, count }));

	await clients.metricsDb.$transaction([
		clients.metricsDb.metricAuthHourly.deleteMany({ where: { bucket, kind: { startsWith: "category:" } } }),
		...(rows.length > 0 ? [clients.metricsDb.metricAuthHourly.createMany({ data: rows })] : []),
	]);
}
