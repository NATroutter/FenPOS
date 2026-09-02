import { addSample, emptyHistogram, type Histogram, serializeHistogram } from "@/lib/metrics/histogram";

/**
 * Turns one hour's terminal jobs into per-printer rollup rows.
 *
 * Pure computation: the caller queries the jobs and writes the rows, so this is testable against
 * fixtures and importable from the seed script. Only terminal jobs belong here — a QUEUED job
 * would need its row rewritten when it settles, and rolled rows are meant to be final. Late
 * settles are absorbed by the caller re-rolling the trailing window (see rollup.ts).
 */

export interface RollupJobInput {
	deviceId: string;
	agentId: string;
	deviceName: string;
	agentName: string;
	status: string;
	submittedAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
	bytes: number | null;
	lines: number | null;
	apiKeyId: string | null;
	errorCode: string | null;
}

export interface JobHourlyRow {
	bucket: Date;
	deviceId: string;
	agentId: string;
	deviceName: string;
	agentName: string;
	completed: number;
	failed: number;
	cancelled: number;
	panelJobs: number;
	apiJobs: number;
	bytesTotal: number;
	linesTotal: number;
	queueHist: string;
	printHist: string;
	totalHist: string;
	queueSumMs: number;
	queueCount: number;
	queueMinMs: number | null;
	queueMaxMs: number | null;
	printSumMs: number;
	printCount: number;
	printMinMs: number | null;
	printMaxMs: number | null;
	totalSumMs: number;
	totalCount: number;
	totalMinMs: number | null;
	totalMaxMs: number | null;
	clockSkewCount: number;
}

export interface ErrorHourlyRow {
	bucket: Date;
	deviceId: string;
	errorCode: string;
	agentId: string;
	deviceName: string;
	agentName: string;
	count: number;
}

/**
 * @returns the duration, clamped at zero; `skewed` when the raw value was negative, which means
 *   the agent's clock disagreed with the server's badly enough to invert the order of events
 */
export function clampedDurationMs(from: Date | null, to: Date | null): { ms: number | null; skewed: boolean } {
	if (!from || !to) {
		return { ms: null, skewed: false };
	}
	const raw = to.getTime() - from.getTime();
	if (raw < 0) {
		return { ms: 0, skewed: true };
	}
	return { ms: raw, skewed: false };
}

interface Accumulator {
	row: JobHourlyRow;
	queue: Histogram;
	print: Histogram;
	total: Histogram;
}

/**
 * Records one duration sample against its histogram and the row's sum/count/min/max fields.
 *
 * Explicit per-prefix branches rather than `row[\`${prefix}SumMs\`]` template-literal property
 * access: the latter needs an index signature or a cast to typecheck, and this keeps the row
 * strongly typed with no `any`.
 */
function recordDuration(
	row: JobHourlyRow,
	hist: Histogram,
	prefix: "queue" | "print" | "total",
	value: { ms: number | null; skewed: boolean },
): void {
	if (value.skewed) {
		row.clockSkewCount += 1;
	}
	if (value.ms === null) {
		return;
	}
	const ms = value.ms;
	addSample(hist, ms);
	switch (prefix) {
		case "queue":
			row.queueSumMs += ms;
			row.queueCount += 1;
			row.queueMinMs = row.queueMinMs === null ? ms : Math.min(row.queueMinMs, ms);
			row.queueMaxMs = row.queueMaxMs === null ? ms : Math.max(row.queueMaxMs, ms);
			break;
		case "print":
			row.printSumMs += ms;
			row.printCount += 1;
			row.printMinMs = row.printMinMs === null ? ms : Math.min(row.printMinMs, ms);
			row.printMaxMs = row.printMaxMs === null ? ms : Math.max(row.printMaxMs, ms);
			break;
		case "total":
			row.totalSumMs += ms;
			row.totalCount += 1;
			row.totalMinMs = row.totalMinMs === null ? ms : Math.min(row.totalMinMs, ms);
			row.totalMaxMs = row.totalMaxMs === null ? ms : Math.max(row.totalMaxMs, ms);
			break;
	}
}

export function computeJobRollup(
	hourStart: Date,
	jobs: RollupJobInput[],
): { jobRows: JobHourlyRow[]; errorRows: ErrorHourlyRow[] } {
	const byDevice = new Map<string, Accumulator>();
	const errors = new Map<string, ErrorHourlyRow>();

	for (const job of jobs) {
		let acc = byDevice.get(job.deviceId);
		if (!acc) {
			acc = {
				queue: emptyHistogram(),
				print: emptyHistogram(),
				total: emptyHistogram(),
				row: {
					bucket: hourStart,
					deviceId: job.deviceId,
					agentId: job.agentId,
					deviceName: job.deviceName,
					agentName: job.agentName,
					completed: 0,
					failed: 0,
					cancelled: 0,
					panelJobs: 0,
					apiJobs: 0,
					bytesTotal: 0,
					linesTotal: 0,
					queueHist: "[]",
					printHist: "[]",
					totalHist: "[]",
					queueSumMs: 0,
					queueCount: 0,
					queueMinMs: null,
					queueMaxMs: null,
					printSumMs: 0,
					printCount: 0,
					printMinMs: null,
					printMaxMs: null,
					totalSumMs: 0,
					totalCount: 0,
					totalMinMs: null,
					totalMaxMs: null,
					clockSkewCount: 0,
				},
			};
			byDevice.set(job.deviceId, acc);
		}
		const row = acc.row;

		if (job.status === "COMPLETED") row.completed += 1;
		else if (job.status === "FAILED") row.failed += 1;
		else if (job.status === "CANCELLED") row.cancelled += 1;

		if (job.apiKeyId) row.apiJobs += 1;
		else row.panelJobs += 1;

		row.bytesTotal += job.bytes ?? 0;
		row.linesTotal += job.lines ?? 0;

		recordDuration(row, acc.queue, "queue", clampedDurationMs(job.submittedAt, job.startedAt));
		recordDuration(row, acc.print, "print", clampedDurationMs(job.startedAt, job.finishedAt));
		recordDuration(row, acc.total, "total", clampedDurationMs(job.submittedAt, job.finishedAt));

		if (job.status === "FAILED" && job.errorCode) {
			const key = `${job.deviceId} ${job.errorCode}`;
			const existing = errors.get(key);
			if (existing) existing.count += 1;
			else
				errors.set(key, {
					bucket: hourStart,
					deviceId: job.deviceId,
					errorCode: job.errorCode,
					agentId: job.agentId,
					deviceName: job.deviceName,
					agentName: job.agentName,
					count: 1,
				});
		}
	}

	const jobRows = [...byDevice.values()].map((acc) => ({
		...acc.row,
		queueHist: serializeHistogram(acc.queue),
		printHist: serializeHistogram(acc.print),
		totalHist: serializeHistogram(acc.total),
	}));
	return { jobRows, errorRows: [...errors.values()] };
}
