/**
 * Fixed-bucket latency histograms.
 *
 * 16 logarithmic buckets from 50 ms to 5 min plus overflow. Fixed rather than adaptive so two
 * hours' histograms merge by element-wise addition — which is what lets a year of hourly rows be
 * re-bucketed to days without ever touching a raw job. Deliberately free of `server-only` and of
 * every `@/lib` import: the seed script and the rollup engine load this outside Next.
 */

export const BUCKET_BOUNDS_MS: readonly number[] = [
	50, 100, 250, 500, 1000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 180000, 240000, 300000,
];

export const BUCKET_COUNT = 16;

/** Counts per bucket; always length {@link BUCKET_COUNT}. */
export type Histogram = number[];

export function emptyHistogram(): Histogram {
	return new Array(BUCKET_COUNT).fill(0);
}

export function bucketIndex(ms: number): number {
	for (let i = 0; i < BUCKET_BOUNDS_MS.length; i++) {
		if (ms <= BUCKET_BOUNDS_MS[i]) {
			return i;
		}
	}
	return BUCKET_COUNT - 1;
}

export function addSample(histogram: Histogram, ms: number): void {
	histogram[bucketIndex(ms)] += 1;
}

export function mergeInto(into: Histogram, from: Histogram): void {
	for (let i = 0; i < BUCKET_COUNT; i++) {
		into[i] += from[i];
	}
}

/**
 * A percentile, linearly interpolated inside the bucket the target rank falls in.
 *
 * The overflow bucket has no upper bound to interpolate towards, so it reports its lower bound —
 * an understatement, which for a chart is the honest direction to be wrong in.
 *
 * @param fraction the percentile as a fraction, e.g. 0.95
 * @returns milliseconds, or null when the histogram is empty
 */
export function histogramPercentile(histogram: Histogram, fraction: number): number | null {
	const total = histogram.reduce((sum, count) => sum + count, 0);
	if (total === 0) {
		return null;
	}
	const target = fraction * total;
	let cumulative = 0;
	for (let i = 0; i < BUCKET_COUNT; i++) {
		const count = histogram[i];
		if (count === 0) {
			continue;
		}
		if (cumulative + count >= target) {
			const lower = i === 0 ? 0 : BUCKET_BOUNDS_MS[i - 1];
			if (i === BUCKET_COUNT - 1) {
				return BUCKET_BOUNDS_MS[BUCKET_BOUNDS_MS.length - 1];
			}
			const upper = BUCKET_BOUNDS_MS[i];
			const within = (target - cumulative) / count;
			return lower + within * (upper - lower);
		}
		cumulative += count;
	}
	return BUCKET_BOUNDS_MS[BUCKET_BOUNDS_MS.length - 1];
}

/** Tolerant on purpose: a corrupt stored row costs one empty histogram, not a broken chart. */
export function parseHistogram(json: string | null | undefined): Histogram {
	if (!json) {
		return emptyHistogram();
	}
	try {
		const parsed: unknown = JSON.parse(json);
		if (
			Array.isArray(parsed) &&
			parsed.length === BUCKET_COUNT &&
			parsed.every((n) => typeof n === "number" && Number.isFinite(n))
		) {
			return parsed as Histogram;
		}
	} catch {
		// fall through
	}
	return emptyHistogram();
}

export function serializeHistogram(histogram: Histogram): string {
	return JSON.stringify(histogram);
}
