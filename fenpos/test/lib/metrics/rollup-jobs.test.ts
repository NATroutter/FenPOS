import { describe, expect, it } from "vitest";
import { parseHistogram } from "@/lib/metrics/histogram";
import { clampedDurationMs, computeJobRollup, type RollupJobInput } from "@/lib/metrics/rollup-jobs";

const HOUR = new Date("2026-08-01T10:00:00Z");

function job(overrides: Partial<RollupJobInput>): RollupJobInput {
	return {
		deviceId: "dev1",
		agentId: "ag1",
		deviceName: "kitchen",
		agentName: "kitchen-pi",
		status: "COMPLETED",
		submittedAt: new Date("2026-08-01T10:05:00Z"),
		startedAt: new Date("2026-08-01T10:05:01Z"),
		finishedAt: new Date("2026-08-01T10:05:03Z"),
		bytes: 512,
		lines: 20,
		apiKeyId: "key1",
		errorCode: null,
		...overrides,
	};
}

describe("computeJobRollup", () => {
	it("groups by device and counts outcomes", () => {
		const { jobRows } = computeJobRollup(HOUR, [
			job({}),
			job({ status: "FAILED", errorCode: "device_unreachable" }),
			job({ deviceId: "dev2", deviceName: "bar" }),
		]);
		expect(jobRows).toHaveLength(2);
		const dev1 = jobRows.find((r) => r.deviceId === "dev1");
		expect(dev1?.completed).toBe(1);
		expect(dev1?.failed).toBe(1);
		expect(dev1?.bucket).toEqual(HOUR);
	});

	it("splits panel from api jobs and sums volume", () => {
		const { jobRows } = computeJobRollup(HOUR, [job({ apiKeyId: null, bytes: 100, lines: 5 }), job({})]);
		const row = jobRows[0];
		expect(row.panelJobs).toBe(1);
		expect(row.apiJobs).toBe(1);
		expect(row.bytesTotal).toBe(612);
		expect(row.linesTotal).toBe(25);
	});

	it("fills all three histograms with clamped durations", () => {
		const { jobRows } = computeJobRollup(HOUR, [job({})]);
		const row = jobRows[0];
		expect(parseHistogram(row.queueHist).reduce((s, n) => s + n, 0)).toBe(1);
		expect(parseHistogram(row.printHist).reduce((s, n) => s + n, 0)).toBe(1);
		expect(parseHistogram(row.totalHist).reduce((s, n) => s + n, 0)).toBe(1);
		expect(row.printSumMs).toBe(2000);
		expect(row.printMinMs).toBe(2000);
		expect(row.printMaxMs).toBe(2000);
	});

	it("counts clock skew instead of recording a negative duration", () => {
		const { jobRows } = computeJobRollup(HOUR, [
			job({ startedAt: new Date("2026-08-01T10:05:05Z"), finishedAt: new Date("2026-08-01T10:05:04Z") }),
		]);
		expect(jobRows[0].clockSkewCount).toBe(1);
		expect(jobRows[0].printSumMs).toBe(0);
	});

	it("emits one error row per (device, code)", () => {
		const { errorRows } = computeJobRollup(HOUR, [
			job({ status: "FAILED", errorCode: "device_unreachable" }),
			job({ status: "FAILED", errorCode: "device_unreachable" }),
			job({ status: "FAILED", errorCode: "body_too_large" }),
		]);
		expect(errorRows).toHaveLength(2);
		expect(errorRows.find((r) => r.errorCode === "device_unreachable")?.count).toBe(2);
	});

	it("a cancelled job with no timestamps contributes counts but no durations", () => {
		const { jobRows } = computeJobRollup(HOUR, [job({ status: "CANCELLED", startedAt: null, finishedAt: null })]);
		expect(jobRows[0].cancelled).toBe(1);
		expect(jobRows[0].printCount).toBe(0);
		expect(jobRows[0].queueCount).toBe(0);
	});
});

describe("clampedDurationMs", () => {
	it("returns null when either side is missing", () => {
		expect(clampedDurationMs(null, new Date()).ms).toBeNull();
	});
	it("clamps negatives to zero and flags the skew", () => {
		const result = clampedDurationMs(new Date(2000), new Date(1000));
		expect(result.ms).toBe(0);
		expect(result.skewed).toBe(true);
	});
});
