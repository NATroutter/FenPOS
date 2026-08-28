import { apiRoute } from "@/lib/api/api-route";
import { assertCursorInFilter, pageOf, readPageParams } from "@/lib/api/pagination";
import { requireApiRead } from "@/lib/auth/rate-limit";
import { prisma } from "@/lib/db";
import { JobStatus } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";

/**
 * `GET /api/v1/jobs` — the jobs this key submitted.
 *
 * **Scoped to the key, not to the device.** The stricter of the two and the right one, for the same
 * reason the single-job endpoint gives: two systems sharing a printer should not be able to read
 * each other's receipts, which carry customer orders and totals.
 *
 * This endpoint exists because losing a `jobId` currently loses the job forever — a caller whose
 * connection dropped between the submit and the 202 has no way to discover whether the receipt
 * printed. Filtering by device and time is what turns that recovery into one request rather than a
 * walk through history.
 *
 * Ordered newest first, with the record id as a tiebreak so a page boundary is stable when two jobs
 * share a submission millisecond.
 */

/** Never cached: a job's state is the entire content. */
export const dynamic = "force-dynamic";

export const GET = apiRoute("api:GET /v1/jobs", async ({ key, request }) => {
	await requireApiRead(key.id);

	const url = new URL(request.url);
	const { take, cursor } = await readPageParams(url);

	const where = {
		apiKeyId: key.id,
		...statusFilter(url),
		...nameFilters(url),
		...sinceFilter(url),
	};

	// A cursor naming a row Prisma would resolve regardless of `where` (another key's job, one
	// this page's status/agent/device/since filter excludes, or nothing at all) must be refused
	// rather than silently mishandled — see assertCursorInFilter's own doc comment for why.
	if (cursor !== null) {
		await assertCursorInFilter(cursor, () =>
			prisma.job.findFirst({ where: { ...where, id: cursor }, select: { id: true } }),
		);
	}

	const rows = await prisma.job.findMany({
		where,
		orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
		take: take + 1,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		select: {
			id: true,
			status: true,
			submittedAt: true,
			queuedAt: true,
			startedAt: true,
			finishedAt: true,
			lines: true,
			bytes: true,
			errorCode: true,
			errorMessage: true,
			device: { select: { name: true, agent: { select: { name: true } } } },
		},
	});

	const { page, nextCursor } = pageOf(rows, take);

	return {
		response: Response.json({
			jobs: page.map((job) => ({
				jobId: job.id,
				status: job.status,
				agent: job.device.agent.name,
				device: job.device.name,
				submittedAt: job.submittedAt.toISOString(),
				queuedAt: job.queuedAt?.toISOString() ?? null,
				startedAt: job.startedAt?.toISOString() ?? null,
				finishedAt: job.finishedAt?.toISOString() ?? null,
				lines: job.lines,
				bytes: job.bytes,
				error: job.errorCode,
				errorMessage: job.errorMessage,
			})),
			nextCursor,
		}),
		// No target: a page of jobs may span every device this key ever printed to.
		message: `Listed ${page.length} jobs`,
	};
});

/**
 * Narrows to one job status.
 *
 * Validated against the closed set rather than passed to Prisma as written: an unrecognised status
 * would silently match nothing, which reads to the caller as "no such jobs" rather than as the typo
 * it is.
 *
 * @param url the request URL
 * @returns a `where` fragment, empty when no status was asked for
 * @throws ApiError `invalid_query` when the status is not one this system uses
 */
function statusFilter(url: URL): { status?: string } {
	const status = url.searchParams.get("status");
	if (status === null) {
		return {};
	}
	if (!JobStatus.is(status)) {
		throw new ApiError("invalid_query", `'${status}' is not a job status.`, { statuses: [...JobStatus.values] });
	}
	return { status };
}

/**
 * Narrows to one agent and/or one device by name.
 *
 * Names rather than ids, because names are what a caller already has: they are what a print path is
 * built from. A name that matches nothing simply returns nothing — unlike a status, a device name is
 * install-specific, so there is no closed set to check it against and no way to tell a typo from a
 * printer this key cannot see.
 *
 * An empty value (`?agent=`) is treated the same as the parameter's absence, not as a filter on the
 * empty string: a device is never named `""`, so a literal reading would always return nothing,
 * silently, for a caller whose only mistake was a template that left the parameter blank rather than
 * omitting it. `readPageParams` in `lib/api/pagination.ts` makes the same choice for `cursor`, for
 * the same reason.
 *
 * @param url the request URL
 * @returns a `where` fragment, empty when neither was asked for
 */
function nameFilters(url: URL): { agent?: { name: string }; device?: { name: string } } {
	const agent = url.searchParams.get("agent");
	const device = url.searchParams.get("device");
	return {
		...(agent ? { agent: { name: agent } } : {}),
		...(device ? { device: { name: device } } : {}),
	};
}

/**
 * Narrows to jobs submitted at or after a moment.
 *
 * @param url the request URL
 * @returns a `where` fragment, empty when no lower bound was asked for
 * @throws ApiError `invalid_query` when the value is not a parseable timestamp
 */
function sinceFilter(url: URL): { submittedAt?: { gte: Date } } {
	const since = url.searchParams.get("since");
	if (since === null) {
		return {};
	}
	const at = new Date(since);
	if (Number.isNaN(at.getTime())) {
		throw new ApiError("invalid_query", "'since' must be an ISO 8601 timestamp.", { since });
	}
	return { submittedAt: { gte: at } };
}
