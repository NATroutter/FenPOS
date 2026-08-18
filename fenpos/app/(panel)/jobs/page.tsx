import Link from "next/link";
import { Filters } from "@/app/(panel)/jobs/filters";
import { JobTable } from "@/app/(panel)/jobs/job-table";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/db";
import { JobStatus } from "@/lib/domain/enums";
import { JOB_PAGE_SIZE, listJobs } from "@/lib/jobs/job-service";

export const metadata = { title: "Print jobs · FenPOS" };

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
	searchParams: Promise<{ agent?: string; device?: string; status?: string; skip?: string }>;
}) {
	const params = await searchParams;
	const skip = Math.max(0, Number.parseInt(params.skip ?? "0", 10) || 0);
	const status = params.status && JobStatus.is(params.status) ? params.status : undefined;

	const [agents, devices, page] = await Promise.all([
		prisma.agent.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
		prisma.device.findMany({
			orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
			select: { id: true, name: true, agent: { select: { name: true } } },
		}),
		listJobs({ agentId: params.agent, deviceId: params.device, status, skip }),
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
			<div className="flex flex-wrap items-end gap-4 border-b border-border pb-3">
				<div className="min-w-[220px] flex-1">
					<h2 className="text-[15px] font-semibold tracking-tight">Print jobs</h2>
					<p className="mt-1 text-[12.5px] text-muted-foreground">
						Every job and what became of it. A job that failed carries the agent's own words about why.
					</p>
				</div>
			</div>

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

			{skip > 0 || page.more ? (
				<div className="flex items-center gap-2">
					{skip > 0 ? (
						<Button
							variant="outline"
							size="sm"
							render={<Link href={query({ skip: String(Math.max(0, skip - JOB_PAGE_SIZE)) })} />}
						>
							Newer
						</Button>
					) : null}
					{page.more ? (
						<Button variant="outline" size="sm" render={<Link href={query({ skip: String(skip + JOB_PAGE_SIZE) })} />}>
							Older
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
