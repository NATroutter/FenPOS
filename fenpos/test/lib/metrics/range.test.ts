import { describe, expect, it } from "vitest";
import { displayBucket, displayBuckets, resolveRange } from "@/lib/metrics/range";

const NOW = new Date("2026-09-02T10:30:00Z");

describe("resolveRange", () => {
	it("resolves presets with the right granularity", () => {
		expect(resolveRange({ preset: "24h" }, NOW).granularity).toBe("hour");
		expect(resolveRange({ preset: "7d" }, NOW).granularity).toBe("day");
		expect(resolveRange({ preset: "90d" }, NOW).granularity).toBe("day");
		expect(resolveRange({ preset: "1y" }, NOW).granularity).toBe("week");
		const day = resolveRange({ preset: "24h" }, NOW);
		expect(day.to.getTime() - day.from.getTime()).toBe(24 * 60 * 60 * 1000);
	});
	it("accepts a custom range and derives granularity from its span", () => {
		const range = resolveRange({ from: "2026-08-01", to: "2026-08-02" }, NOW);
		expect(range.granularity).toBe("hour");
		expect(range.from).toEqual(new Date("2026-08-01T00:00:00Z"));
	});
	it("falls back to 7d on garbage", () => {
		expect(resolveRange({ preset: "yes please" }, NOW).granularity).toBe("day");
	});
});

describe("displayBuckets", () => {
	it("is gap-free at day granularity", () => {
		const buckets = displayBuckets({
			from: new Date("2026-08-01T00:00:00Z"),
			to: new Date("2026-08-04T00:00:00Z"),
			granularity: "day",
		});
		expect(buckets).toHaveLength(3);
		expect(buckets[1]).toEqual(new Date("2026-08-02T00:00:00Z"));
	});
	it("truncates weeks to Monday", () => {
		expect(displayBucket(new Date("2026-09-02T10:00:00Z"), "week")).toEqual(new Date("2026-08-31T00:00:00Z"));
	});
});
