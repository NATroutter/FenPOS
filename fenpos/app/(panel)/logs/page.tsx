import Link from "next/link";
import { Filters } from "@/app/(panel)/jobs/filters";
import { FollowProvider, FollowToggle } from "@/app/(panel)/logs/follow";
import { LogStream } from "@/app/(panel)/logs/log-stream";
import { Button } from "@/components/ui/button";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { FILTERABLE_LEVELS, isFilterableLevel, listLogs } from "@/lib/logs/log-service";
import { isLogSortColumn } from "@/lib/logs/log-sort";
import { integerSetting } from "@/lib/settings/settings-service";

export const metadata = { title: "Logs" };

/** Never cached: lines arrive without any request to this page causing them. */
export const dynamic = "force-dynamic";

/**
 * The Logs tab.
 *
 * What the agents chose to forward, not everything they logged. Each agent keeps its own complete
 * log on its own machine; this is the subset an operator watching the panel would act on. A log
 * that carried every line from every site would be one nobody reads.
 */
export default async function LogsPage({
	searchParams,
}: {
	searchParams: Promise<{ agent?: string; level?: string; skip?: string; sort?: string; dir?: string }>;
}) {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("logs:read");

	const params = await searchParams;
	const skip = Math.max(0, Number.parseInt(params.skip ?? "0", 10) || 0);
	// Anything else in the URL — including `DEBUG`, which the dropdown used to offer — falls back to
	// no filter. That is the same set of rows `DEBUG` would have selected, and it keeps a stale
	// bookmark from putting a value in the trigger that the dropdown has no label for.
	const level = params.level && isFilterableLevel(params.level) ? params.level : undefined;
	const sort = params.sort && isLogSortColumn(params.sort) ? params.sort : undefined;
	const desc = params.dir ? params.dir !== "asc" : undefined;

	const pageSize = await integerSetting("panel.logPageSize");

	const [agents, page] = await Promise.all([
		prisma.agent.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
		listLogs({ agentId: params.agent, level, skip, sort, desc, take: pageSize }),
	]);

	// The live stream is paused whenever a filter, a page or a sort is in play. A filter or a page
	// would be shown lines it excludes; a sort would have them pushed onto the top of an ordering
	// that does not put them there. In every case the arriving line contradicts what the view says
	// it is, so the honest move is to stop and let the operator reload.
	const live = !params.agent && !level && skip === 0 && !sort;

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
		<FollowProvider streamable={live}>
			<div className="flex flex-col gap-5">
				<div className="flex flex-wrap items-center gap-3">
					<Filters
						filters={[
							{
								name: "agent",
								label: "Agent",
								value: params.agent ?? null,
								options: agents.map((agent) => ({ value: agent.id, label: agent.name })),
							},
							{
								name: "level",
								label: "Level",
								value: level ?? null,
								options: FILTERABLE_LEVELS.map((value) => ({
									value,
									label: `${value.toLowerCase()} and worse`,
								})),
							},
						]}
					/>

					<div className="flex-1" />

					{/* Beside the toggle rather than under the list: it is the reason the toggle is
				    disabled, and the two only read correctly together. */}
					{live ? null : (
						<span className="text-[11.5px] text-subtle-foreground">Live updates paused while filtered.</span>
					)}
					<FollowToggle />
				</div>

				<LogStream lines={page.lines} />

				{skip > 0 || page.more ? (
					<div className="flex items-center gap-2">
						{skip > 0 ? (
							<Button
								variant="outline"
								size="sm"
								render={<Link href={query({ skip: String(Math.max(0, skip - pageSize)) })} />}
							>
								Newer
							</Button>
						) : null}
						{page.more ? (
							<Button variant="outline" size="sm" render={<Link href={query({ skip: String(skip + pageSize) })} />}>
								Older
							</Button>
						) : null}
					</div>
				) : null}
			</div>
		</FollowProvider>
	);
}
