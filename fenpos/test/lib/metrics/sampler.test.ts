import { beforeEach, describe, expect, it } from "vitest";
import { metricsDb, prisma } from "@/lib/db";
import { takeFleetSample } from "@/lib/metrics/sampler";

describe("takeFleetSample", () => {
	beforeEach(async () => {
		await metricsDb.fleetSample.deleteMany();
	});

	it("writes one row with real counts", async () => {
		await prisma.agent.create({ data: { name: "sample-agent", status: "OFFLINE" } });
		await takeFleetSample(new Date());
		const rows = await metricsDb.fleetSample.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].agentsTotal).toBeGreaterThanOrEqual(1);
		expect(rows[0].agentsOnline).toBe(0); // nothing holds a socket in a test
		expect(rows[0].dbMainBytes).toBeGreaterThan(0);
	});
});
