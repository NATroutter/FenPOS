import { Filters } from "@/app/(panel)/jobs/filters";
import { JobList } from "@/app/(panel)/jobs/job-list";
import { parseJobsSearchParams } from "@/app/(panel)/jobs/search-params";
import { JOB_PERMISSIONS } from "@/app/(panel)/tab-permits";
import { permitsFor } from "@/lib/auth/permits";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { JobStatus } from "@/lib/domain/enums";
import { listJobs } from "@/lib/jobs/job-service";
import { integerSetting } from "@/lib/settings/settings-service";

export const metadata = { title: "Print jobs" };

/** Never cached: a job's state changes without any request to this page causing it. */
export const dynamic = "force-dynamic";

/**
 * The Jobs tab.
 *
 * Every job, whoever submitted it — unlike the public API, where a key sees only its own. That
 * difference is deliberate: a key is a machine doing one thing, an administrator is a person
 * working out why a printer is quiet, and they need to see the jobs they did not submit.
 *
 * **Scrolls rather than pages.** The server component below still renders one page-size worth of
 * jobs — `panel.jobPageSize`, unchanged — and `JobList` appends further batches as the operator
 * scrolls, through `listMoreJobs`. A stale bookmark carrying `?skip=` from before this feature is
 * simply ignored: this page reads no such parameter, so it renders the first page exactly as any
 * other visit would.
 */
export default async function JobsPage({
	searchParams,
}: {
	searchParams: Promise<{
		agent?: string;
		device?: string;
		status?: string;
		sort?: string;
		dir?: string;
	}>;
}) {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("jobs:read", "/jobs");

	const params = await searchParams;
	const { agentIds, deviceIds, statuses, sort, desc } = parseJobsSearchParams(params);

	const pageSize = await integerSetting("panel.jobPageSize");

	const [agents, devices, page, permits] = await Promise.all([
		prisma.agent.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
		prisma.device.findMany({
			orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
			select: { id: true, name: true, agent: { select: { name: true } } },
		}),
		listJobs({ agentId: agentIds, deviceId: deviceIds, status: statuses, sort, desc, take: pageSize }),
		// Resolved here because a client component cannot read the database. Convenience only — every
		// action is refused again by its own gate; see `permitsFor`.
		permitsFor(user, JOB_PERMISSIONS),
	]);

	return (
		<div className="flex flex-col gap-5">
			<Filters
				filters={[
					{
						name: "agent",
						label: "Agent",
						values: agentIds,
						options: agents.map((agent) => ({ value: agent.id, label: agent.name })),
					},
					{
						name: "device",
						label: "Printer",
						values: deviceIds,
						options: devices.map((device) => ({
							value: device.id,
							label: `${device.agent.name}/${device.name}`,
						})),
					},
					{
						name: "status",
						label: "State",
						values: statuses,
						options: JobStatus.values.map((value) => ({ value, label: value.toLowerCase() })),
					},
				]}
			/>

			<JobList
				// Remounts on a real filter or sort change, so scroll history from one query is never
				// reconciled against another's — see `components/panel/infinite-scroll.tsx`.
				key={JSON.stringify({ agentIds, deviceIds, statuses, sort, desc })}
				initial={{ jobs: page.jobs, more: page.more }}
				query={{
					agent: params.agent,
					device: params.device,
					status: params.status,
					sort: params.sort,
					dir: params.dir,
				}}
				live
				canCancel={permits["jobs:cancel"]}
			/>
		</div>
	);
}
