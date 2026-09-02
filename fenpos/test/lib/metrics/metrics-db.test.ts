import { describe, expect, it } from "vitest";
import { metricsDb } from "@/lib/db";

describe("metrics database", () => {
	it("accepts and returns a fleet sample row", async () => {
		const at = new Date("2026-01-01T00:00:00Z");
		await metricsDb.fleetSample.create({
			data: {
				at,
				agentsTotal: 2,
				agentsOnline: 1,
				devicesTotal: 4,
				devicesConnected: 3,
				queueDepth: 0,
				pendingWebhooks: 0,
				activeSessions: 1,
				dbMainBytes: 1000,
				dbAuditBytes: 1000,
				dbLogsBytes: 1000,
			},
		});
		const rows = await metricsDb.fleetSample.findMany({ where: { at } });
		expect(rows).toHaveLength(1);
	});
});
