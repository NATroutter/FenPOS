/**
 * Range presets, custom ranges, and display bucketing shared by every stats tab.
 *
 * Pure — no `server-only`, no `@/lib` imports — so it loads in the browser bundle (for the
 * range picker) as freely as it loads in a server query.
 */

export type RangePreset = "24h" | "7d" | "30d" | "90d" | "1y";
export type Granularity = "hour" | "day" | "week";

export interface ResolvedRange {
	from: Date;
	to: Date;
	granularity: Granularity;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PRESET_SPAN_MS: Record<RangePreset, number> = {
	"24h": 24 * HOUR_MS,
	"7d": 7 * DAY_MS,
	"30d": 30 * DAY_MS,
	"90d": 90 * DAY_MS,
	"1y": 365 * DAY_MS,
};

function isRangePreset(value: unknown): value is RangePreset {
	return typeof value === "string" && Object.hasOwn(PRESET_SPAN_MS, value);
}

function granularityForSpan(spanMs: number): Granularity {
	if (spanMs <= 2 * DAY_MS) return "hour";
	if (spanMs <= 90 * DAY_MS) return "day";
	return "week";
}

/** UTC start-of-day for an ISO `YYYY-MM-DD` (or any ISO date-time) string, or null when unparseable. */
function parseStartOfDay(value: string): Date | null {
	const datePart = value.slice(0, 10);
	const date = new Date(`${datePart}T00:00:00.000Z`);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** UTC end-of-day for an ISO `YYYY-MM-DD` (or any ISO date-time) string, or null when unparseable. */
function parseEndOfDay(value: string): Date | null {
	const datePart = value.slice(0, 10);
	const date = new Date(`${datePart}T23:59:59.999Z`);
	return Number.isNaN(date.getTime()) ? null : date;
}

function presetRange(preset: RangePreset, now: Date): ResolvedRange {
	const span = PRESET_SPAN_MS[preset];
	const to = now;
	const from = new Date(now.getTime() - span);
	return { from, to, granularity: granularityForSpan(span) };
}

/**
 * Resolves a range-picker input into concrete bounds and a display granularity.
 *
 * A valid `preset` always wins. Otherwise a valid `from`/`to` pair (start-of-day through
 * end-of-day, UTC) is used. Anything else — an unrecognised preset, a missing or malformed
 * custom range — falls back to the "7d" preset.
 */
export function resolveRange(
	input: { preset?: string; from?: string; to?: string },
	now: Date = new Date(),
): ResolvedRange {
	if (isRangePreset(input.preset)) {
		return presetRange(input.preset, now);
	}

	if (input.from && input.to) {
		const from = parseStartOfDay(input.from);
		const to = parseEndOfDay(input.to);
		if (from && to && to.getTime() > from.getTime()) {
			return { from, to, granularity: granularityForSpan(to.getTime() - from.getTime()) };
		}
	}

	return presetRange("7d", now);
}

/** Truncates `date` to the start of its display bucket, in UTC. Weeks truncate to Monday. */
export function displayBucket(date: Date, granularity: Granularity): Date {
	if (granularity === "hour") {
		return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
	}

	const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	if (granularity === "day") {
		return dayStart;
	}

	// granularity === "week": Monday 00:00 UTC. getUTCDay() is 0=Sunday..6=Saturday; (day + 6) % 7
	// is the number of days since the most recent Monday.
	const daysSinceMonday = (dayStart.getUTCDay() + 6) % 7;
	return new Date(dayStart.getTime() - daysSinceMonday * DAY_MS);
}

const GRANULARITY_STEP_MS: Record<Granularity, number> = {
	hour: HOUR_MS,
	day: DAY_MS,
	week: 7 * DAY_MS,
};

/** Every bucket start covering `range`, gap-free, half-open on `range.to`. */
export function displayBuckets(range: ResolvedRange): Date[] {
	const step = GRANULARITY_STEP_MS[range.granularity];
	const buckets: Date[] = [];
	let cursor = displayBucket(range.from, range.granularity);
	while (cursor.getTime() < range.to.getTime()) {
		buckets.push(cursor);
		cursor = new Date(cursor.getTime() + step);
	}
	return buckets;
}
