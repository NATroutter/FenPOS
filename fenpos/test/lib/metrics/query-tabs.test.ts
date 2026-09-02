import { beforeEach, describe, expect, it } from "vitest";
import { auditDb, metricsDb, prisma } from "@/lib/db";
import { addSample, emptyHistogram, serializeHistogram } from "@/lib/metrics/histogram";
import { apiTabData } from "@/lib/metrics/query/api";
import { fleetTabData } from "@/lib/metrics/query/fleet";
import { jobsTabData } from "@/lib/metrics/query/jobs";
import { latencyTabData } from "@/lib/metrics/query/latency";
import { overviewTabData } from "@/lib/metrics/query/overview";
import { reliabilityTabData } from "@/lib/metrics/query/reliability";
import { securityTabData } from "@/lib/metrics/query/security";
import { webhooksTabData } from "@/lib/metrics/query/webhooks";
import { displayBuckets, type ResolvedRange } from "@/lib/metrics/range";
import { hourStart } from "@/lib/metrics/rollup";

/**
 * One describe per tab module. Each hand-computes at least one value and checks every time series
 * comes back the length `displayBuckets(range)` promises.
 *
 * A stream merging rolled + live data (jobs, webhooks, the audit category kinds) is forced entirely
 * onto the live path by parking its watermark at the Unix epoch — `jobSeries` and its rolled/live
 * split are already covered by `query-series.test.ts`; these tests are only responsible for how each
 * tab module shapes that data, so there is no need to re-prove the merge itself.
 */

function hourRange(hoursAgo = 24): ResolvedRange {
	return { from: new Date(Date.now() - hoursAgo * 60 * 60 * 1000), to: new Date(), granularity: "hour" };
}

async function forceLiveWatermark(stream: "jobs" | "webhooks" | "audit"): Promise<void> {
	await metricsDb.metricWatermark.upsert({
		where: { stream },
		update: { rolledThrough: new Date(0) },
		create: { stream, rolledThrough: new Date(0) },
	});
}

describe("overviewTabData", () => {
	beforeEach(async () => {
		await prisma.job.deleteMany();
		await metricsDb.metricJobHourly.deleteMany();
		await metricsDb.metricWatermark.deleteMany();
		await metricsDb.fleetSample.deleteMany();
	});

	it("returns correctly sized series and a hand-computed success rate", async () => {
		const agent = await prisma.agent.upsert({
			where: { name: "ov-agent" },
			update: {},
			create: { name: "ov-agent", status: "OFFLINE" },
		});
		const device = await prisma.device.upsert({
			where: { agentId_name: { agentId: agent.id, name: "ov-dev" } },
			update: {},
			create: { agentId: agent.id, name: "ov-dev", port: "COM1" },
		});
		await forceLiveWatermark("jobs");

		const mk = (status: string, finishedAt: Date) =>
			prisma.job.create({
				data: {
					agentId: agent.id,
					deviceId: device.id,
					status,
					submittedAt: new Date(finishedAt.getTime() - 3000),
					startedAt: new Date(finishedAt.getTime() - 1000),
					finishedAt,
					bytes: 100,
				},
			});
		await mk("COMPLETED", new Date(Date.now() - 60 * 60 * 1000));
		await mk("COMPLETED", new Date(Date.now() - 30 * 60 * 1000));
		await mk("FAILED", new Date(Date.now() - 10 * 60 * 1000));
		await metricsDb.fleetSample.create({
			data: {
				at: new Date(Date.now() - 40 * 60 * 1000),
				agentsTotal: 4,
				agentsOnline: 2,
				devicesTotal: 0,
				devicesConnected: 0,
				queueDepth: 0,
				pendingWebhooks: 0,
				activeSessions: 0,
				dbMainBytes: 0,
				dbAuditBytes: 0,
				dbLogsBytes: 0,
			},
		});

		const range = hourRange(24);
		const result = await overviewTabData(range, { agentId: agent.id });

		expect(result.jobsOverTime).toHaveLength(displayBuckets(range).length);
		expect(result.availability).toHaveLength(displayBuckets(range).length);
		expect(result.failuresOverTime).toHaveLength(displayBuckets(range).length);
		expect(result.cards.jobs.value).toBe(3);
		expect(result.cards.successRate.value).toBeCloseTo(2 / 3);
		expect(result.cards.agentsOnline).toEqual({ online: 0, total: 1 });
		expect(result.cards.printersConnected).toEqual({ connected: 0, total: 1 });
		expect(result.cards.queueDepth).toBe(0);

		const sampledAvailability = result.availability.find((b) => b.agentsOnline === 2 && b.agentsTotal === 4);
		expect(sampledAvailability).toBeDefined();
		// A bucket with no fleet samples in it must report null, not a false zero.
		const firstBucketIso = displayBuckets(range)[0].toISOString();
		expect(result.availability.find((b) => b.t === firstBucketIso)).toEqual({
			t: firstBucketIso,
			agentsOnline: null,
			agentsTotal: null,
		});
	});
});

describe("jobsTabData", () => {
	beforeEach(async () => {
		await prisma.job.deleteMany();
		await metricsDb.metricJobHourly.deleteMany();
		await metricsDb.metricWatermark.deleteMany();
	});

	it("returns correctly sized series and hand-computed breakdowns", async () => {
		const agent = await prisma.agent.upsert({
			where: { name: "jobs-agent" },
			update: {},
			create: { name: "jobs-agent", status: "OFFLINE" },
		});
		const device = await prisma.device.upsert({
			where: { agentId_name: { agentId: agent.id, name: "jobs-dev" } },
			update: {},
			create: { agentId: agent.id, name: "jobs-dev", port: "COM2" },
		});
		const key = await prisma.apiKey.upsert({
			where: { keyHash: "jobs-key-hash" },
			update: {},
			create: { name: "Jobs Key", keyHash: "jobs-key-hash", maskedHint: "abcd" },
		});
		await forceLiveWatermark("jobs");

		const mk = (apiKeyId: string | null, bytes: number, finishedAt: Date) =>
			prisma.job.create({
				data: {
					agentId: agent.id,
					deviceId: device.id,
					apiKeyId,
					status: "COMPLETED",
					bytes,
					submittedAt: new Date(finishedAt.getTime() - 3000),
					startedAt: new Date(finishedAt.getTime() - 1000),
					finishedAt,
				},
			});
		const now = Date.now();
		await mk(key.id, 100, new Date(now - 30 * 60 * 1000)); // <256B
		await mk(key.id, 5000, new Date(now - 20 * 60 * 1000)); // <16K
		await mk(null, 50, new Date(now - 10 * 60 * 1000)); // panel, <256B

		const range = hourRange(24);
		const result = await jobsTabData(range, { agentId: agent.id });

		expect(result.jobsOverTime).toHaveLength(displayBuckets(range).length);
		expect(result.bySource).toHaveLength(displayBuckets(range).length);
		expect(result.averageSize).toHaveLength(displayBuckets(range).length);

		expect(result.topKeys).toContainEqual({ name: "Jobs Key", jobs: 2 });
		expect(result.topKeys).toContainEqual({ name: "Panel", jobs: 1 });
		expect(result.topPrinters).toContainEqual({ name: "jobs-dev", jobs: 3 });
		expect(result.topAgents).toContainEqual({ name: "jobs-agent", jobs: 3 });

		const under256 = result.sizeDistribution.find((b) => b.bucket === "<256B");
		expect(under256?.count).toBe(2);
		const under16k = result.sizeDistribution.find((b) => b.bucket === "<16K");
		expect(under16k?.count).toBe(1);
	});
});

describe("reliabilityTabData", () => {
	beforeEach(async () => {
		await prisma.job.deleteMany();
		await metricsDb.metricErrorHourly.deleteMany();
		await metricsDb.metricJobHourly.deleteMany();
		await metricsDb.metricWatermark.deleteMany();
	});

	it("returns correctly sized series and hand-computed rates", async () => {
		const agent = await prisma.agent.upsert({
			where: { name: "rel-agent" },
			update: {},
			create: { name: "rel-agent", status: "OFFLINE" },
		});
		const device = await prisma.device.upsert({
			where: { agentId_name: { agentId: agent.id, name: "rel-dev" } },
			update: {},
			create: { agentId: agent.id, name: "rel-dev", port: "COM3" },
		});
		await forceLiveWatermark("jobs");

		// Every job lands in the same hour bucket, so exactly one bucket's rate is non-null.
		const finishedAt = new Date(Date.now() - 5 * 60 * 1000);
		const mk = (status: string, errorCode: string | null) =>
			prisma.job.create({
				data: {
					agentId: agent.id,
					deviceId: device.id,
					status,
					errorCode,
					submittedAt: new Date(finishedAt.getTime() - 3000),
					startedAt: new Date(finishedAt.getTime() - 1000),
					finishedAt,
				},
			});
		await mk("COMPLETED", null);
		await mk("COMPLETED", null);
		await mk("FAILED", "device_unreachable");
		await mk("CANCELLED", null);

		const range = hourRange(24);
		const result = await reliabilityTabData(range, { agentId: agent.id });

		expect(result.successRate).toHaveLength(displayBuckets(range).length);
		expect(result.cancellationRate).toHaveLength(displayBuckets(range).length);

		const successBucket = result.successRate.find((b) => b.rate !== null);
		expect(successBucket?.rate).toBeCloseTo(2 / 3);
		const cancelBucket = result.cancellationRate.find((b) => b.rate !== null);
		expect(cancelBucket?.rate).toBeCloseTo(1 / 4);

		expect(result.byErrorCode).toContainEqual({ code: "device_unreachable", count: 1 });
		const errorRow = result.errorTable.find((r) => r.code === "device_unreachable");
		expect(errorRow?.count).toBe(1);
		expect(errorRow?.lastSeen).not.toBeNull();
		expect(result.failuresByPrinter).toContainEqual({ name: "rel-dev", failed: 1 });
	});
});

describe("latencyTabData", () => {
	beforeEach(async () => {
		await prisma.job.deleteMany();
		await metricsDb.metricJobHourly.deleteMany();
		await metricsDb.metricWatermark.deleteMany();
	});

	it("returns correctly sized series and a hand-computed p50", async () => {
		const agent = await prisma.agent.upsert({
			where: { name: "lat-agent" },
			update: {},
			create: { name: "lat-agent", status: "OFFLINE" },
		});
		const device = await prisma.device.upsert({
			where: { agentId_name: { agentId: agent.id, name: "lat-dev" } },
			update: {},
			create: { agentId: agent.id, name: "lat-dev", port: "COM4" },
		});
		await forceLiveWatermark("jobs");

		const finishedAt = new Date(Date.now() - 5 * 60 * 1000);
		const startedAt = new Date(finishedAt.getTime() - 100); // exactly 100ms print duration
		await prisma.job.create({
			data: {
				agentId: agent.id,
				deviceId: device.id,
				status: "COMPLETED",
				submittedAt: new Date(startedAt.getTime() - 50),
				startedAt,
				finishedAt,
			},
		});

		const range = hourRange(24);
		const result = await latencyTabData(range, { agentId: agent.id });

		expect(result.printPercentiles).toHaveLength(displayBuckets(range).length);
		expect(result.queuePercentiles).toHaveLength(displayBuckets(range).length);
		expect(result.totalPercentiles).toHaveLength(displayBuckets(range).length);

		// A single 100ms sample falls in the [50, 100] histogram bucket; p50 interpolates to its
		// midpoint (50 + 0.5 * (100 - 50) = 75).
		const nonNullPrint = result.printPercentiles.find((b) => b.p50 !== null);
		expect(nonNullPrint?.p50).toBeCloseTo(75);

		const slowest = result.slowestPrinters.find((p) => p.name === "lat-dev");
		expect(slowest?.p95Ms).toBeCloseTo(97.5);
		const bucket100 = result.distribution.find((b) => b.bucket === "≤100ms");
		expect(bucket100?.count).toBe(1);
		expect(result.clockSkewCount).toBe(0);
	});
});

describe("fleetTabData", () => {
	beforeEach(async () => {
		await metricsDb.fleetSample.deleteMany();
	});

	it("returns correctly sized series, averages samples, and overrides a stale ONLINE status", async () => {
		const agent = await prisma.agent.upsert({
			where: { name: "fleet-agent" },
			update: { status: "ONLINE", agentVersion: "1.2.3", platform: "linux" },
			create: { name: "fleet-agent", status: "ONLINE", agentVersion: "1.2.3", platform: "linux" },
		});
		await metricsDb.fleetSample.create({
			data: {
				at: new Date(Date.now() - 30 * 60 * 1000),
				agentsTotal: 5,
				agentsOnline: 3,
				devicesTotal: 10,
				devicesConnected: 7,
				queueDepth: 2,
				pendingWebhooks: 0,
				activeSessions: 1,
				dbMainBytes: 1000,
				dbAuditBytes: 1000,
				dbLogsBytes: 1000,
			},
		});

		const range = hourRange(24);
		const result = await fleetTabData(range, { agentId: agent.id });

		expect(result.agentsOnline).toHaveLength(displayBuckets(range).length);
		expect(result.devicesConnected).toHaveLength(displayBuckets(range).length);
		expect(result.queueDepth).toHaveLength(displayBuckets(range).length);

		// The DB row says ONLINE, but nothing holds a live connection in a test — the module must
		// override it to OFFLINE rather than trust the stored column.
		expect(result.statusNow).toEqual([{ status: "OFFLINE", count: 1 }]);
		expect(result.versions).toContainEqual({ version: "1.2.3", count: 1 });
		expect(result.platforms).toContainEqual({ platform: "linux", count: 1 });

		const sampledBucket = result.agentsOnline.find((b) => b.online === 3 && b.total === 5);
		expect(sampledBucket).toBeDefined();

		// A bucket with no fleet samples in it must report null, not a false zero — the whole range
		// only has one sample, ~30 minutes ago, so the earliest display bucket (~24h ago) is empty.
		const firstBucketIso = displayBuckets(range)[0].toISOString();
		expect(result.agentsOnline.find((b) => b.t === firstBucketIso)).toEqual({
			t: firstBucketIso,
			online: null,
			total: null,
		});
		expect(result.devicesConnected.find((b) => b.t === firstBucketIso)).toEqual({
			t: firstBucketIso,
			connected: null,
			total: null,
		});
		expect(result.queueDepth.find((b) => b.t === firstBucketIso)).toEqual({ t: firstBucketIso, depth: null });
	});
});

describe("webhooksTabData", () => {
	beforeEach(async () => {
		await prisma.webhookDelivery.deleteMany();
		await metricsDb.metricWebhookHourly.deleteMany();
		await metricsDb.metricWatermark.deleteMany();
		await metricsDb.fleetSample.deleteMany();
	});

	it("returns correctly sized series and hand-computed delivery counts", async () => {
		const key = await prisma.apiKey.upsert({
			where: { keyHash: "webhook-key-hash" },
			update: {},
			create: { name: "Webhook Key", keyHash: "webhook-key-hash", maskedHint: "wxyz" },
		});
		const webhook = await prisma.webhook.upsert({
			where: { apiKeyId: key.id },
			update: {},
			create: { apiKeyId: key.id, url: "https://example.test/hook", secret: "s3cr3t" },
		});
		await forceLiveWatermark("webhooks");

		await prisma.webhookDelivery.create({
			data: {
				webhookId: webhook.id,
				jobId: "job-1",
				payload: "{}",
				status: "DELIVERED",
				attempts: 1,
				deliveredAt: new Date(Date.now() - 10 * 60 * 1000),
				createdAt: new Date(Date.now() - 15 * 60 * 1000),
			},
		});
		await prisma.webhookDelivery.create({
			data: {
				webhookId: webhook.id,
				jobId: "job-2",
				payload: "{}",
				status: "FAILED",
				attempts: 3,
				nextAttemptAt: new Date(Date.now() - 5 * 60 * 1000),
				createdAt: new Date(Date.now() - 20 * 60 * 1000),
			},
		});
		await metricsDb.fleetSample.create({
			data: {
				at: new Date(Date.now() - 40 * 60 * 1000),
				agentsTotal: 0,
				agentsOnline: 0,
				devicesTotal: 0,
				devicesConnected: 0,
				queueDepth: 0,
				pendingWebhooks: 4,
				activeSessions: 0,
				dbMainBytes: 0,
				dbAuditBytes: 0,
				dbLogsBytes: 0,
			},
		});

		const range = hourRange(24);
		const result = await webhooksTabData(range, {});

		expect(result.deliveries).toHaveLength(displayBuckets(range).length);
		expect(result.successRate).toHaveLength(displayBuckets(range).length);
		expect(result.backlog).toHaveLength(displayBuckets(range).length);

		const sampledBacklog = result.backlog.find((b) => b.pending === 4);
		expect(sampledBacklog).toBeDefined();
		// A bucket with no fleet samples in it must report null, not a false zero.
		const firstBucketIso = displayBuckets(range)[0].toISOString();
		expect(result.backlog.find((b) => b.t === firstBucketIso)).toEqual({ t: firstBucketIso, pending: null });

		const totalDelivered = result.deliveries.reduce((sum, b) => sum + b.delivered, 0);
		const totalFailed = result.deliveries.reduce((sum, b) => sum + b.failed, 0);
		expect(totalDelivered).toBe(1);
		expect(totalFailed).toBe(1);
		expect(result.perWebhook).toContainEqual({ name: "Webhook Key", delivered: 1, failed: 1 });

		const attemptsBucket3 = result.attempts.find((a) => a.bucket === "3");
		expect(attemptsBucket3?.count).toBe(1);
		const attemptsBucket1 = result.attempts.find((a) => a.bucket === "1");
		expect(attemptsBucket1?.count).toBe(1);
	});
});

describe("apiTabData", () => {
	beforeEach(async () => {
		await metricsDb.metricApiHourly.deleteMany();
	});

	it("returns correctly sized series and excludes reject:* pseudo-routes from requests", async () => {
		const bucket = hourStart(new Date());
		const hist = emptyHistogram();
		addSample(hist, 100);

		await metricsDb.metricApiHourly.create({
			data: {
				bucket,
				route: "/v1/jobs",
				statusClass: "2xx",
				apiKeyId: "",
				count: 1,
				durationSumMs: 100,
				durationHist: serializeHistogram(hist),
			},
		});
		await metricsDb.metricApiHourly.create({
			data: {
				bucket,
				route: "reject:auth",
				statusClass: "4xx",
				apiKeyId: "",
				count: 2,
				durationSumMs: 20,
				durationHist: serializeHistogram(emptyHistogram()),
			},
		});

		const range = hourRange(24);
		const result = await apiTabData(range, {});

		expect(result.requests).toHaveLength(displayBuckets(range).length);
		expect(result.rejections).toHaveLength(displayBuckets(range).length);
		expect(result.responsePercentiles).toHaveLength(displayBuckets(range).length);

		const totalOk = result.requests.reduce((sum, b) => sum + b.ok, 0);
		expect(totalOk).toBe(1); // reject:auth excluded
		const totalAuthRejections = result.rejections.reduce((sum, b) => sum + b.auth, 0);
		expect(totalAuthRejections).toBe(2);

		expect(result.byEndpoint).toContainEqual({ route: "/v1/jobs", count: 1 });
		expect(result.byKey).toContainEqual({ name: "(unauthenticated)", count: 1 });

		// The one real request's 100ms sample interpolates to the same p50 as latency's test: 75.
		const nonNullP50 = result.responsePercentiles.find((b) => b.p50 !== null);
		expect(nonNullP50?.p50).toBeCloseTo(75);
	});
});

describe("securityTabData", () => {
	beforeEach(async () => {
		await metricsDb.metricAuthHourly.deleteMany();
		await metricsDb.metricWatermark.deleteMany();
		await auditDb.auditEvent.deleteMany();
		await metricsDb.fleetSample.deleteMany();
	});

	it("returns correctly sized series and hand-computed sign-in/denied totals from live counters", async () => {
		const bucket = hourStart(new Date());
		await metricsDb.metricAuthHourly.create({ data: { bucket, kind: "signin_success", count: 3 } });
		await metricsDb.metricAuthHourly.create({ data: { bucket, kind: "signin_failed", count: 1 } });
		await metricsDb.metricAuthHourly.create({ data: { bucket, kind: "denied_action", count: 2 } });
		await metricsDb.fleetSample.create({
			data: {
				at: new Date(Date.now() - 45 * 60 * 1000),
				agentsTotal: 0,
				agentsOnline: 0,
				devicesTotal: 0,
				devicesConnected: 0,
				queueDepth: 0,
				pendingWebhooks: 0,
				activeSessions: 5,
				dbMainBytes: 2 * 1024 * 1024,
				dbAuditBytes: 1024 * 1024,
				dbLogsBytes: 512 * 1024,
			},
		});

		const range = hourRange(24);
		const result = await securityTabData(range, {});

		expect(result.signIns).toHaveLength(displayBuckets(range).length);
		expect(result.deniedActions).toHaveLength(displayBuckets(range).length);
		expect(result.auditCategories).toHaveLength(displayBuckets(range).length);
		expect(result.activeSessions).toHaveLength(displayBuckets(range).length);
		expect(result.storage).toHaveLength(displayBuckets(range).length);

		const totalSuccess = result.signIns.reduce((sum, b) => sum + b.success, 0);
		const totalFailed = result.signIns.reduce((sum, b) => sum + b.failed, 0);
		expect(totalSuccess).toBe(3);
		expect(totalFailed).toBe(1);
		const totalDenied = result.deniedActions.reduce((sum, b) => sum + b.denied, 0);
		expect(totalDenied).toBe(2);

		const sampledSessions = result.activeSessions.find((b) => b.sessions === 5);
		expect(sampledSessions).toBeDefined();
		const sampledStorage = result.storage.find((b) => b.mainMB !== null);
		expect(sampledStorage?.mainMB).toBeCloseTo(2);
		expect(sampledStorage?.auditMB).toBeCloseTo(1);
		expect(sampledStorage?.logsMB).toBeCloseTo(0.5);

		// A bucket with no fleet samples in it must report null, not a false zero.
		const firstBucketIso = displayBuckets(range)[0].toISOString();
		expect(result.activeSessions.find((b) => b.t === firstBucketIso)).toEqual({
			t: firstBucketIso,
			sessions: null,
		});
		expect(result.storage.find((b) => b.t === firstBucketIso)).toEqual({
			t: firstBucketIso,
			mainMB: null,
			auditMB: null,
			logsMB: null,
		});
	});

	it("reads failedByIp and auditCategories from raw audit rows", async () => {
		await forceLiveWatermark("audit");

		let seq = 0;
		const seedEvent = (action: string, outcome: string, ipAddress: string | null, at: Date) => {
			seq += 1;
			return auditDb.auditEvent.create({
				data: {
					at,
					actorKind: "USER",
					action,
					outcome,
					ipAddress,
					prevHash: `test-prev-${seq}`,
					hash: `test-hash-${seq}`,
				},
			});
		};

		const now = Date.now();
		await seedEvent("auth:sign-in", "FAILURE", "10.0.0.1", new Date(now - 5 * 60 * 1000));
		await seedEvent("auth:sign-in", "FAILURE", "10.0.0.1", new Date(now - 4 * 60 * 1000));
		await seedEvent("auth:sign-in", "SUCCESS", "10.0.0.2", new Date(now - 3 * 60 * 1000));
		await seedEvent("devices:delete", "SUCCESS", "10.0.0.3", new Date(now - 2 * 60 * 1000));

		const range = hourRange(24);
		const result = await securityTabData(range, {});

		expect(result.failedByIp).toContainEqual({ ip: "10.0.0.1", count: 2 });

		const categoryTotal = result.auditCategories.reduce((sum, row) => {
			const value = row["category:devices"];
			return sum + (typeof value === "number" ? value : 0);
		}, 0);
		expect(categoryTotal).toBe(1);
	});
});
