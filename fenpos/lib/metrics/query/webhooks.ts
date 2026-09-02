import "server-only";
import { metricsDb, prisma } from "@/lib/db";
import type { MetricsFilter } from "@/lib/metrics/query/series";
import { displayBucket, displayBuckets, type ResolvedRange } from "@/lib/metrics/range";
import { hourStart } from "@/lib/metrics/rollup";

/**
 * The Webhooks tab: delivery throughput, attempt counts, and per-webhook breakdown.
 *
 * `deliveries`/`successRate`/`perWebhook` merge `MetricWebhookHourly` (the settled past) with a live
 * count over raw `WebhookDelivery` rows since the webhooks stream's watermark — the same rolled/live
 * split `jobSeries` uses for jobs, applied here by hand since the webhooks watermark has no exported
 * helper of its own. `MetricsFilter` (agent/device) does not apply anywhere on this tab: deliveries
 * relate to API keys, not to agents or devices.
 */

export interface WebhooksTabData {
	deliveries: { t: string; delivered: number; failed: number; queued: number }[];
	successRate: { t: string; rate: number | null }[];
	attempts: { bucket: string; count: number }[];
	perWebhook: { name: string; delivered: number; failed: number }[];
	backlog: { t: string; pending: number | null }[];
}

async function webhooksWatermark(): Promise<Date> {
	const row = await metricsDb.metricWatermark.findUnique({ where: { stream: "webhooks" } });
	return row ? row.rolledThrough : hourStart(new Date());
}

interface WebhookBucket {
	t: Date;
	queued: number;
	delivered: number;
	failed: number;
}

async function webhookSeries(range: ResolvedRange, watermark: Date): Promise<WebhookBucket[]> {
	const rolledEnd = watermark.getTime() < range.to.getTime() ? watermark : range.to;

	const buckets = new Map<number, WebhookBucket>();
	for (const t of displayBuckets(range)) buckets.set(t.getTime(), { t, queued: 0, delivered: 0, failed: 0 });

	function bucketFor(t: Date): WebhookBucket {
		const key = displayBucket(t, range.granularity).getTime();
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { t: new Date(key), queued: 0, delivered: 0, failed: 0 };
			buckets.set(key, bucket);
		}
		return bucket;
	}

	const rolledFrom = hourStart(range.from);
	if (rolledEnd.getTime() > rolledFrom.getTime()) {
		const rows = await metricsDb.metricWebhookHourly.findMany({
			where: { bucket: { gte: rolledFrom, lt: rolledEnd } },
		});
		for (const row of rows) {
			const bucket = bucketFor(row.bucket);
			bucket.queued += row.queued;
			bucket.delivered += row.delivered;
			bucket.failed += row.failed;
		}
	}

	if (range.to.getTime() > watermark.getTime()) {
		const [created, delivered, failed] = await Promise.all([
			prisma.webhookDelivery.findMany({
				where: { createdAt: { gte: watermark, lt: range.to } },
				select: { createdAt: true },
			}),
			prisma.webhookDelivery.findMany({
				where: { deliveredAt: { gte: watermark, lt: range.to } },
				select: { deliveredAt: true },
			}),
			prisma.webhookDelivery.findMany({
				where: { status: "FAILED", nextAttemptAt: { gte: watermark, lt: range.to } },
				select: { nextAttemptAt: true },
			}),
		]);
		for (const row of created) bucketFor(row.createdAt).queued += 1;
		for (const row of delivered) if (row.deliveredAt) bucketFor(row.deliveredAt).delivered += 1;
		for (const row of failed) bucketFor(row.nextAttemptAt).failed += 1;
	}

	return [...buckets.values()].sort((a, b) => a.t.getTime() - b.t.getTime());
}

async function perWebhookBreakdown(
	range: ResolvedRange,
	watermark: Date,
): Promise<{ name: string; delivered: number; failed: number }[]> {
	const rolledEnd = watermark.getTime() < range.to.getTime() ? watermark : range.to;
	const byWebhook = new Map<string, { name: string; delivered: number; failed: number }>();

	function acc(id: string, name: string): { name: string; delivered: number; failed: number } {
		let entry = byWebhook.get(id);
		if (!entry) {
			entry = { name, delivered: 0, failed: 0 };
			byWebhook.set(id, entry);
		}
		return entry;
	}

	const rolledFrom = hourStart(range.from);
	if (rolledEnd.getTime() > rolledFrom.getTime()) {
		const rows = await metricsDb.metricWebhookHourly.findMany({
			where: { bucket: { gte: rolledFrom, lt: rolledEnd } },
		});
		for (const row of rows) {
			const entry = acc(row.webhookId, row.webhookName);
			entry.delivered += row.delivered;
			entry.failed += row.failed;
		}
	}

	if (range.to.getTime() > watermark.getTime()) {
		const [delivered, failed] = await Promise.all([
			prisma.webhookDelivery.findMany({
				where: { deliveredAt: { gte: watermark, lt: range.to } },
				select: { webhookId: true, webhook: { select: { apiKey: { select: { name: true } } } } },
			}),
			prisma.webhookDelivery.findMany({
				where: { status: "FAILED", nextAttemptAt: { gte: watermark, lt: range.to } },
				select: { webhookId: true, webhook: { select: { apiKey: { select: { name: true } } } } },
			}),
		]);
		for (const row of delivered) acc(row.webhookId, row.webhook.apiKey.name).delivered += 1;
		for (const row of failed) acc(row.webhookId, row.webhook.apiKey.name).failed += 1;
	}

	return [...byWebhook.values()].sort((a, b) => b.delivered + b.failed - (a.delivered + a.failed));
}

// `filter` is accepted, not applied — see the module comment — so every tab module shares the same
// `(range, filter)` signature the page shell calls them with.
export async function webhooksTabData(range: ResolvedRange, filter: MetricsFilter): Promise<WebhooksTabData> {
	void filter;
	const watermark = await webhooksWatermark();
	const [series, perWebhook, rawAttempts, samples] = await Promise.all([
		webhookSeries(range, watermark),
		perWebhookBreakdown(range, watermark),
		prisma.webhookDelivery.findMany({
			where: { createdAt: { gte: range.from, lt: range.to }, attempts: { gt: 0 } },
			select: { attempts: true },
		}),
		metricsDb.fleetSample.findMany({ where: { at: { gte: range.from, lt: range.to } } }),
	]);

	const deliveries = series.map((bucket) => ({
		t: bucket.t.toISOString(),
		delivered: bucket.delivered,
		failed: bucket.failed,
		queued: bucket.queued,
	}));
	const successRate = series.map((bucket) => {
		const denom = bucket.delivered + bucket.failed;
		return { t: bucket.t.toISOString(), rate: denom > 0 ? bucket.delivered / denom : null };
	});

	const attemptCounts = [0, 0, 0, 0, 0]; // 1, 2, 3, 4, 5+
	for (const row of rawAttempts) {
		attemptCounts[Math.min(row.attempts, 5) - 1] += 1;
	}
	const attempts = [
		{ bucket: "1", count: attemptCounts[0] },
		{ bucket: "2", count: attemptCounts[1] },
		{ bucket: "3", count: attemptCounts[2] },
		{ bucket: "4", count: attemptCounts[3] },
		{ bucket: "5+", count: attemptCounts[4] },
	];

	const buckets = new Map<number, number[]>();
	for (const t of displayBuckets(range)) buckets.set(t.getTime(), []);
	for (const sample of samples) {
		const key = displayBucket(sample.at, range.granularity).getTime();
		const list = buckets.get(key);
		if (list) {
			list.push(sample.pendingWebhooks);
		} else {
			buckets.set(key, [sample.pendingWebhooks]);
		}
	}
	// A bucket with no samples yields null — a gap in the chart, not a false zero.
	const backlog = [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([key, list]) => ({
			t: new Date(key).toISOString(),
			pending: list.length ? Math.round(list.reduce((sum, v) => sum + v, 0) / list.length) : null,
		}));

	return { deliveries, successRate, attempts, perWebhook, backlog };
}
