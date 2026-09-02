import { beforeEach, describe, expect, it } from "vitest";
import { metricsDb, prisma } from "@/lib/db";
import { runMaintenancePass } from "@/lib/maintenance/pass";
import { setSetting } from "@/lib/settings/settings-service";

describe("maintenance runs the metrics rollup", () => {
	beforeEach(async () => {
		// The test database is per worker process, not per file, so a setting another file in this
		// worker left overridden (`stats.enabled=false`, in particular) would otherwise leak in here
		// and silently skip the rollup. Cleared like the ~50 other suites that depend on defaults.
		await prisma.setting.deleteMany();
		await prisma.job.deleteMany();
		await metricsDb.metricJobHourly.deleteMany();
		await metricsDb.metricWatermark.deleteMany();
	});

	it("rolls a completed hour during a pass", async () => {
		const agent = await prisma.agent.create({ data: { name: "maint-agent", status: "OFFLINE" } });
		const device = await prisma.device.create({ data: { agentId: agent.id, name: "maint-dev", port: "COM8" } });
		const finished = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await prisma.job.create({
			data: {
				agentId: agent.id,
				deviceId: device.id,
				status: "COMPLETED",
				submittedAt: new Date(finished.getTime() - 3000),
				startedAt: new Date(finished.getTime() - 1000),
				finishedAt: finished,
			},
		});
		await runMaintenancePass();
		expect(await metricsDb.metricJobHourly.count()).toBeGreaterThan(0);
	});

	it("does nothing when stats.enabled is off", async () => {
		await setSetting("stats.enabled", false);
		await runMaintenancePass();
		expect(await metricsDb.metricWatermark.count()).toBe(0);
		await setSetting("stats.enabled", true);
	});
});
