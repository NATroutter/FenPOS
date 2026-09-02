import { beforeEach, describe, expect, it } from "vitest";
import { metricsDb, prisma } from "@/lib/db";
import { jobSeries } from "@/lib/metrics/query/series";
import { hourStart, runMetricsRollup } from "@/lib/metrics/rollup";

describe("jobSeries", () => {
	beforeEach(async () => {
		await prisma.job.deleteMany();
		await metricsDb.metricJobHourly.deleteMany();
		await metricsDb.metricWatermark.deleteMany();
	});

	// The live query's window is [watermark, range.to); a job seeded at "now minus a few minutes"
	// only lands in that window when the wall clock isn't within a few minutes of an hour
	// boundary (otherwise its effective hour falls before the watermark and it is absorbed by the
	// next rollup's trailing re-roll instead). Anchoring the live job to `watermark + 1s`, and the
	// query's `to` a full hour past `now`, makes these deterministic regardless of when they run.
	async function jobsWatermarkRow() {
		const watermark = await metricsDb.metricWatermark.findUnique({ where: { stream: "jobs" } });
		if (!watermark) {
			throw new Error("expected a jobs watermark row after runMetricsRollup");
		}
		return watermark;
	}

	function wideRange(now: Date) {
		return {
			from: new Date(now.getTime() - 48 * 60 * 60 * 1000),
			to: new Date(now.getTime() + 60 * 60 * 1000),
			granularity: "hour" as const,
		};
	}

	it("counts a rolled job once and a live (unrolled) job once", async () => {
		const agent = await prisma.agent.create({ data: { name: "series-agent", status: "OFFLINE" } });
		const device = await prisma.device.create({ data: { agentId: agent.id, name: "series-dev", port: "COM7" } });
		const mk = (finishedAt: Date) =>
			prisma.job.create({
				data: {
					agentId: agent.id,
					deviceId: device.id,
					status: "COMPLETED",
					submittedAt: new Date(finishedAt.getTime() - 3000),
					startedAt: new Date(finishedAt.getTime() - 1000),
					finishedAt,
				},
			});
		await mk(new Date(Date.now() - 30 * 60 * 60 * 1000)); // old — will be rolled
		await runMetricsRollup({ db: prisma, metricsDb, auditDb: null });
		const watermark = await jobsWatermarkRow();
		await mk(new Date(watermark.rolledThrough.getTime() + 1000)); // just past the watermark — live only
		const series = await jobSeries(wideRange(new Date()), {});
		const total = series.reduce((sum, bucket) => sum + bucket.completed, 0);
		expect(total).toBe(2);
	});

	it("filters by device", async () => {
		const agent = await prisma.agent.create({ data: { name: "series-agent-2", status: "OFFLINE" } });
		const deviceA = await prisma.device.create({ data: { agentId: agent.id, name: "series-dev-a", port: "COM8" } });
		const deviceB = await prisma.device.create({ data: { agentId: agent.id, name: "series-dev-b", port: "COM9" } });
		await runMetricsRollup({ db: prisma, metricsDb, auditDb: null }); // nothing to roll — just parks the watermark
		const watermark = await jobsWatermarkRow();
		const mk = (deviceId: string, finishedAt: Date) =>
			prisma.job.create({
				data: {
					agentId: agent.id,
					deviceId,
					status: "COMPLETED",
					submittedAt: new Date(finishedAt.getTime() - 3000),
					startedAt: new Date(finishedAt.getTime() - 1000),
					finishedAt,
				},
			});
		await mk(deviceA.id, new Date(watermark.rolledThrough.getTime() + 1000));
		await mk(deviceB.id, new Date(watermark.rolledThrough.getTime() + 1000));
		const series = await jobSeries(wideRange(new Date()), { deviceId: deviceA.id });
		const total = series.reduce((sum, bucket) => sum + bucket.completed, 0);
		expect(total).toBe(1);
	});

	it("includes a rolled hour whose bucket start is before a non-hour-aligned range.from", async () => {
		const agent = await prisma.agent.create({ data: { name: "series-agent-3", status: "OFFLINE" } });
		const device = await prisma.device.create({ data: { agentId: agent.id, name: "series-dev-3", port: "COM10" } });
		// An hour firmly in the past, so it is safely rolled (and outside the trailing re-roll
		// window) after a single rollup pass.
		const anchorHour = hourStart(new Date(Date.now() - 30 * 60 * 60 * 1000));
		const finishedAt = new Date(anchorHour.getTime() + 5 * 60 * 1000); // 5 minutes into the hour
		await prisma.job.create({
			data: {
				agentId: agent.id,
				deviceId: device.id,
				status: "COMPLETED",
				submittedAt: new Date(finishedAt.getTime() - 3000),
				startedAt: new Date(finishedAt.getTime() - 1000),
				finishedAt,
			},
		});
		await runMetricsRollup({ db: prisma, metricsDb, auditDb: null });

		// A range.from that lands mid-hour, after the job but still inside the rolled bucket's
		// hour — the bug this test guards against dropped that entire bucket.
		const from = new Date(anchorHour.getTime() + 30 * 60 * 1000);
		const series = await jobSeries({ from, to: new Date(), granularity: "hour" }, {});
		const total = series.reduce((sum, bucket) => sum + bucket.completed, 0);
		expect(total).toBe(1);
	});
});
