import { describe, expect, it } from "vitest";
import {
	addSample,
	BUCKET_BOUNDS_MS,
	BUCKET_COUNT,
	bucketIndex,
	emptyHistogram,
	histogramPercentile,
	mergeInto,
	parseHistogram,
	serializeHistogram,
} from "@/lib/metrics/histogram";

describe("bucketIndex", () => {
	it("places a value on a bound into that bound's bucket", () => {
		expect(bucketIndex(50)).toBe(0);
		expect(bucketIndex(51)).toBe(1);
		expect(bucketIndex(300000)).toBe(14);
	});
	it("places anything past the last bound into the overflow bucket", () => {
		expect(bucketIndex(300001)).toBe(15);
		expect(bucketIndex(Number.MAX_SAFE_INTEGER)).toBe(15);
	});
	it("clamps a negative value into the first bucket", () => {
		expect(bucketIndex(-5)).toBe(0);
	});
});

describe("addSample and mergeInto", () => {
	it("accumulates counts and merges element-wise", () => {
		const a = emptyHistogram();
		addSample(a, 40);
		addSample(a, 900);
		const b = emptyHistogram();
		addSample(b, 900);
		mergeInto(a, b);
		expect(a[0]).toBe(1);
		expect(a[4]).toBe(2); // 900 ms is in the (500, 1000] bucket
		expect(a.reduce((s, n) => s + n, 0)).toBe(3);
	});
});

describe("histogramPercentile", () => {
	it("returns null for an empty histogram", () => {
		expect(histogramPercentile(emptyHistogram(), 0.5)).toBeNull();
	});
	it("interpolates inside the crossing bucket", () => {
		const h = emptyHistogram();
		// 100 samples all in bucket 4, whose range is (500, 1000].
		h[4] = 100;
		const p50 = histogramPercentile(h, 0.5);
		expect(p50).toBeGreaterThan(500);
		expect(p50).toBeLessThanOrEqual(1000);
	});
	it("orders p50 <= p95 <= p99 on a spread distribution", () => {
		const h = emptyHistogram();
		h[2] = 90; // most jobs 100-250 ms
		h[10] = 9; // some 30-60 s
		h[15] = 1; // one stuck past 5 min
		const p50 = histogramPercentile(h, 0.5);
		const p95 = histogramPercentile(h, 0.95);
		const p99 = histogramPercentile(h, 0.99);
		expect(p50).not.toBeNull();
		if (p50 === null || p95 === null || p99 === null) throw new Error("unreachable");
		expect(p50).toBeLessThanOrEqual(p95);
		expect(p95).toBeLessThanOrEqual(p99);
	});
	it("reports the overflow bucket as its lower bound", () => {
		const h = emptyHistogram();
		h[15] = 10;
		expect(histogramPercentile(h, 0.5)).toBe(BUCKET_BOUNDS_MS[BUCKET_BOUNDS_MS.length - 1]);
	});
});

describe("serialization", () => {
	it("round-trips", () => {
		const h = emptyHistogram();
		addSample(h, 1234);
		expect(parseHistogram(serializeHistogram(h))).toEqual(h);
	});
	it("returns empty on garbage, null, and wrong length", () => {
		expect(parseHistogram(null)).toEqual(emptyHistogram());
		expect(parseHistogram("not json")).toEqual(emptyHistogram());
		expect(parseHistogram("[1,2]")).toEqual(emptyHistogram());
	});
	it("BUCKET_COUNT matches the bounds plus overflow", () => {
		expect(BUCKET_COUNT).toBe(BUCKET_BOUNDS_MS.length + 1);
	});
});
