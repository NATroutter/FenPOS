import { beforeEach, describe, expect, it } from "vitest";
import { metricsDb, prisma } from "@/lib/db";
import { jobSeries } from "@/lib/metrics/query/series";
import { runMetricsRollup } from "@/lib/metrics/rollup";

describe("jobSeries", () => {
	beforeEach(async () => {
		await prisma.job.deleteMany();
		await metricsDb.metricJobHourly.deleteMany();
		await metricsDb.metricWatermark.deleteMany();
	});

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
		await mk(new Date(Date.now() - 10 * 60 * 1000)); // current hour — live only
		const series = await jobSeries(
			{ from: new Date(Date.now() - 48 * 60 * 60 * 1000), to: new Date(), granularity: "hour" },
			{},
		);
		const total = series.reduce((sum, bucket) => sum + bucket.completed, 0);
		expect(total).toBe(2);
	});

	it("filters by device", async () => {
		const agent = await prisma.agent.create({ data: { name: "series-agent-2", status: "OFFLINE" } });
		const deviceA = await prisma.device.create({ data: { agentId: agent.id, name: "series-dev-a", port: "COM8" } });
		const deviceB = await prisma.device.create({ data: { agentId: agent.id, name: "series-dev-b", port: "COM9" } });
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
		await mk(deviceA.id, new Date(Date.now() - 10 * 60 * 1000));
		await mk(deviceB.id, new Date(Date.now() - 10 * 60 * 1000));
		const series = await jobSeries(
			{ from: new Date(Date.now() - 48 * 60 * 60 * 1000), to: new Date(), granularity: "hour" },
			{ deviceId: deviceA.id },
		);
		const total = series.reduce((sum, bucket) => sum + bucket.completed, 0);
		expect(total).toBe(1);
	});
});
