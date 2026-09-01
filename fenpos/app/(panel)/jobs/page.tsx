import Link from "next/link";
import { Filters } from "@/app/(panel)/jobs/filters";
import { JobTable } from "@/app/(panel)/jobs/job-table";
import { buttonVariants } from "@/components/ui/button";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { JobStatus } from "@/lib/domain/enums";
import { listJobs } from "@/lib/jobs/job-service";
import { isJobSortColumn } from "@/lib/jobs/job-sort";
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
 */
export default async function JobsPage({
	searchParams,
}: {
	searchParams: Promise<{
		agent?: string;
		device?: string;
		status?: string;
		skip?: string;
		sort?: string;
		dir?: string;
	}>;
}) {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("jobs:read", "/jobs");

	const params = await searchParams;
	const skip = Math.max(0, Number.parseInt(params.skip ?? "0", 10) || 0);
	const status = params.status && JobStatus.is(params.status) ? params.status : undefined;
	// An unknown column falls back to the default rather than erroring: a link someone saved before
	// a column was renamed should still list jobs.
	const sort = params.sort && isJobSortColumn(params.sort) ? params.sort : undefined;
	const desc = params.dir ? params.dir !== "asc" : undefined;

	const pageSize = await integerSetting("panel.jobPageSize");

	const [agents, devices, page] = await Promise.all([
		prisma.agent.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
		prisma.device.findMany({
			orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
			select: { id: true, name: true, agent: { select: { name: true } } },
		}),
		listJobs({ agentId: params.agent, deviceId: params.device, status, skip, sort, desc, take: pageSize }),
	]);

	const query = (next: Record<string, string | undefined>): string => {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries({ ...params, ...next })) {
			if (value) {
				search.set(key, value);
			}
		}
		const rendered = search.toString();
		return rendered ? `?${rendered}` : "?";
	};

	return (
		<div className="flex flex-col gap-5">
			<Filters
				filters={[
					{
						name: "agent",
						label: "Agent",
						value: params.agent ?? null,
						options: agents.map((agent) => ({ value: agent.id, label: agent.name })),
					},
					{
						name: "device",
						label: "Printer",
						value: params.device ?? null,
						options: devices.map((device) => ({
							value: device.id,
							label: `${device.agent.name}/${device.name}`,
						})),
					},
					{
						name: "status",
						label: "State",
						value: status ?? null,
						options: JobStatus.values.map((value) => ({ value, label: value.toLowerCase() })),
					},
				]}
			/>

			<JobTable jobs={page.jobs} live />

			{/* Links, not Base UI Buttons rendering anchors — see the note on the Audit page. */}
			{skip > 0 || page.more ? (
				<div className="flex items-center gap-2">
					{skip > 0 ? (
						<Link
							href={query({ skip: String(Math.max(0, skip - pageSize)) })}
							className={buttonVariants({ variant: "outline", size: "sm" })}
						>
							Newer
						</Link>
					) : null}
					{page.more ? (
						<Link
							href={query({ skip: String(skip + pageSize) })}
							className={buttonVariants({ variant: "outline", size: "sm" })}
						>
							Older
						</Link>
					) : null}
				</div>
			) : null}
		</div>
	);
}
