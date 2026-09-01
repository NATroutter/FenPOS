import "server-only";
import { prisma } from "@/lib/db";
import { isTerminalJobStatus, type JobStatus, JobStatus as JobStatusSet } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { JOB_DEFAULT_SORT, type JobSortColumn } from "@/lib/jobs/job-sort";
import { getLink } from "@/lib/link/registry";
import { logger } from "@/lib/logger";
import { integerSetting } from "@/lib/settings/settings-service";
import { anyOf } from "@/lib/table/multi-filter";
import type { SortDirection } from "@/lib/table/sort";

/**
 * Reading and cancelling jobs from the panel.
 *
 * The panel sees every job, unlike an API key, which sees only its own. That difference is the
 * point of the two surfaces: a key is a machine with one job to do, an administrator is a person
 * trying to work out why a printer is quiet.
 */

/** A job as the Jobs tab displays it. */
export interface JobSummary {
	id: string;
	status: JobStatus;
	agentName: string;
	deviceName: string;
	keyName: string | null;
	submittedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	lines: number | null;
	bytes: number | null;
	errorCode: string | null;
	errorMessage: string | null;
}

/**
 * How each sortable column becomes an `orderBy`.
 *
 * The names themselves live in {@link JOB_SORT_COLUMNS}, which the table imports too; this is the
 * half that reaches Prisma and so stays behind `server-only`. Keyed by that same union, so a
 * column added there without a mapping here is a type error rather than a silent no-op.
 */
const JOB_ORDER = {
	submitted: (dir: SortDirection) => ({ submittedAt: dir }),
	status: (dir: SortDirection) => ({ status: dir }),
	lines: (dir: SortDirection) => ({ lines: dir }),
	bytes: (dir: SortDirection) => ({ bytes: dir }),
	printer: (dir: SortDirection) => [{ agent: { name: dir } }, { device: { name: dir } }],
} as const satisfies Record<JobSortColumn, (dir: SortDirection) => unknown>;

/**
 * What the list is narrowed to.
 *
 * Each takes one value or several: the tab's dropdowns are multi-select, so "failed or cancelled"
 * is one question rather than two page loads. See `anyOf` (`lib/table/multi-filter.ts`).
 */
export interface JobFilter {
	agentId?: string | string[];
	deviceId?: string | string[];
	status?: JobStatus | JobStatus[];
	/** How many to skip, for paging. */
	skip?: number;
	/** Which column to order by. Defaults to {@link JOB_DEFAULT_SORT}. */
	sort?: JobSortColumn;
	/** Which way that ordering runs. Defaults to {@link JOB_DEFAULT_SORT}. */
	desc?: boolean;
	/** How many rows to return. Defaults to the configured `panel.jobPageSize`. */
	take?: number;
}

/**
 * Lists jobs, newest first.
 *
 * @param filter what to narrow to
 * @returns the page of jobs and whether more follow
 */
export async function listJobs(filter: JobFilter = {}): Promise<{ jobs: JobSummary[]; more: boolean }> {
	const agentId = anyOf(filter.agentId);
	const deviceId = anyOf(filter.deviceId);
	const status = anyOf(filter.status);
	const where = {
		...(agentId ? { agentId } : {}),
		...(deviceId ? { deviceId } : {}),
		...(status ? { status } : {}),
	};

	const direction: SortDirection = (filter.desc ?? JOB_DEFAULT_SORT.desc) ? "desc" : "asc";
	const chosen = JOB_ORDER[filter.sort ?? JOB_DEFAULT_SORT.column](direction);
	// Ties broken by submission time so a page boundary is stable. Without it, two jobs with the
	// same byte count could swap places between one page view and the next, which on a paged list
	// shows a row twice and hides another.
	const orderBy = [...(Array.isArray(chosen) ? chosen : [chosen]), { submittedAt: "desc" as const }];

	const take = filter.take ?? (await integerSetting("panel.jobPageSize"));

	// One extra row is fetched rather than counting the whole table, which on a busy install is a
	// scan run on every page view to answer a question worth one boolean.
	const rows = await prisma.job.findMany({
		where,
		orderBy,
		skip: filter.skip ?? 0,
		take: take + 1,
		include: {
			agent: { select: { name: true } },
			device: { select: { name: true } },
			apiKey: { select: { name: true } },
		},
	});

	const page = rows.slice(0, take);

	return {
		more: rows.length > take,
		jobs: page.map((row) => ({
			id: row.id,
			status: (JobStatusSet.is(row.status) ? row.status : "FAILED") as JobStatus,
			agentName: row.agent.name,
			deviceName: row.device.name,
			// Null means the panel submitted it. Shown as such rather than left blank, because a
			// blank column reads as missing data rather than as an answer.
			keyName: row.apiKey?.name ?? null,
			submittedAt: row.submittedAt.toISOString(),
			startedAt: row.startedAt?.toISOString() ?? null,
			finishedAt: row.finishedAt?.toISOString() ?? null,
			lines: row.lines,
			bytes: row.bytes,
			errorCode: row.errorCode,
			errorMessage: row.errorMessage,
		})),
	};
}

/**
 * Asks the agent to withdraw a job that has not started.
 *
 * Nothing is written here. Cancellation is a request, not a fact the server can assert: only the
 * machine holding the printer knows whether the job is still waiting or already halfway through
 * the paper, and marking it cancelled regardless would report a receipt as withdrawn while it was
 * being handed to a customer. The agent's job update is what settles the row.
 *
 * @param jobId the job to withdraw
 * @throws ApiError when the job is unknown, already finished, or its agent is offline
 */
export async function cancelJob(jobId: string): Promise<void> {
	const job = await prisma.job.findUnique({
		where: { id: jobId },
		select: { id: true, status: true, agentId: true },
	});

	if (!job) {
		throw new ApiError("unknown_job", "That job no longer exists.");
	}

	if (JobStatusSet.is(job.status) && isTerminalJobStatus(job.status)) {
		throw new ApiError("job_not_cancellable", `That job is already ${job.status.toLowerCase()}.`);
	}

	const link = getLink(job.agentId);
	if (!link) {
		throw new ApiError("agent_offline", "That agent is not connected, so the job cannot be cancelled.");
	}

	if (!link.send({ type: "job.cancel", jobId: job.id })) {
		throw new ApiError("agent_offline", "That agent disconnected before the request was sent.");
	}

	logger.info("Job cancellation requested from the panel", { jobId: job.id });
}

/**
 * Counts jobs by state, for the dashboard.
 *
 * @param since only count jobs submitted after this moment
 * @returns one count per state, including states with none
 */
export async function countJobsByStatus(since: Date): Promise<Record<JobStatus, number>> {
	const grouped = await prisma.job.groupBy({
		by: ["status"],
		where: { submittedAt: { gte: since } },
		_count: { _all: true },
	});

	const counts = Object.fromEntries(JobStatusSet.values.map((status) => [status, 0])) as Record<JobStatus, number>;

	for (const row of grouped) {
		if (JobStatusSet.is(row.status)) {
			counts[row.status] = row._count._all;
		}
	}

	return counts;
}
