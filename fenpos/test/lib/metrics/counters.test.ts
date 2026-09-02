import { beforeEach, describe, expect, it } from "vitest";
import { metricsDb } from "@/lib/db";
import { authKindsForAudit, flushMetricCounters, recordApiMetric, recordAuthKind } from "@/lib/metrics/counters";
import { parseHistogram } from "@/lib/metrics/histogram";

beforeEach(async () => {
	await metricsDb.metricApiHourly.deleteMany();
	await metricsDb.metricAuthHourly.deleteMany();
	await flushMetricCounters(); // drain anything a previous test recorded
	await metricsDb.metricApiHourly.deleteMany();
	await metricsDb.metricAuthHourly.deleteMany();
});

describe("api counters", () => {
	it("accumulates and flushes into hourly rows", async () => {
		recordApiMetric({ route: "api:POST /v1/print", status: 200, apiKeyId: "k1", durationMs: 12 });
		recordApiMetric({ route: "api:POST /v1/print", status: 200, apiKeyId: "k1", durationMs: 30 });
		await flushMetricCounters();
		const rows = await metricsDb.metricApiHourly.findMany({ where: { route: "api:POST /v1/print" } });
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(2);
		expect(rows[0].durationSumMs).toBe(42);
		expect(parseHistogram(rows[0].durationHist).reduce((s, n) => s + n, 0)).toBe(2);
	});

	it("flushes additively so two flushes in one hour merge", async () => {
		recordApiMetric({ route: "api:GET /v1/jobs", status: 200, apiKeyId: "k1", durationMs: 5 });
		await flushMetricCounters();
		recordApiMetric({ route: "api:GET /v1/jobs", status: 200, apiKeyId: "k1", durationMs: 5 });
		await flushMetricCounters();
		const rows = await metricsDb.metricApiHourly.findMany({ where: { route: "api:GET /v1/jobs" } });
		expect(rows[0].count).toBe(2);
	});

	it("records rejection pseudo-routes and auth kinds for refused calls", async () => {
		recordApiMetric({ route: "api:POST /v1/print", status: 401, apiKeyId: null, durationMs: 2 });
		recordApiMetric({ route: "api:POST /v1/print", status: 429, apiKeyId: "k1", durationMs: 2 });
		await flushMetricCounters();
		const rejects = await metricsDb.metricApiHourly.findMany({ where: { route: { startsWith: "reject:" } } });
		expect(rejects.map((r) => r.route).sort()).toEqual(["reject:auth", "reject:rate-limit"]);
		const kinds = await metricsDb.metricAuthHourly.findMany();
		expect(kinds.map((k) => k.kind).sort()).toEqual(["api_auth_failed", "rate_limited"]);
	});
});

describe("authKindsForAudit", () => {
	it("maps sign-in outcomes", () => {
		expect(authKindsForAudit("auth:sign-in", "SUCCESS")).toEqual(["signin_success", "session_created"]);
		expect(authKindsForAudit("auth:sign-in", "FAILURE")).toEqual(["signin_failed"]);
		expect(authKindsForAudit("auth:two-factor", "FAILURE")).toEqual(["twofactor_failed"]);
		expect(authKindsForAudit("devices:delete", "DENIED")).toEqual(["denied_action"]);
		expect(authKindsForAudit("devices:delete", "SUCCESS")).toEqual([]);
	});
});

describe("recordAuthKind", () => {
	it("flushes into metric_auth_hourly", async () => {
		recordAuthKind("signin_failed");
		recordAuthKind("signin_failed");
		await flushMetricCounters();
		const rows = await metricsDb.metricAuthHourly.findMany({ where: { kind: "signin_failed" } });
		expect(rows[0].count).toBe(2);
	});
});
