import Link from "next/link";
import { Filters } from "@/app/(panel)/jobs/filters";
import { LogStream } from "@/app/(panel)/logs/log-stream";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/db";
import { LogLevel } from "@/lib/domain/enums";
import { LOG_PAGE_SIZE, listLogs } from "@/lib/logs/log-service";

export const metadata = { title: "Logs · FenPOS" };

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
	searchParams: Promise<{ agent?: string; level?: string; skip?: string }>;
}) {
	const params = await searchParams;
	const skip = Math.max(0, Number.parseInt(params.skip ?? "0", 10) || 0);
	const level = params.level && LogLevel.is(params.level) ? params.level : undefined;

	const [agents, page] = await Promise.all([
		prisma.agent.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
		listLogs({ agentId: params.agent, level, skip }),
	]);

	// The live stream is paused whenever a filter or a page is in play: showing lines the current
	// view excludes would make the filter mean nothing.
	const live = !params.agent && !level && skip === 0;

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
					<h2 className="text-[15px] font-semibold tracking-tight">Logs</h2>
					<p className="mt-1 text-[12.5px] text-muted-foreground">
						What the agents forwarded. Each also keeps its own complete log on the machine it runs on.
					</p>
				</div>
			</div>

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
							options: LogLevel.values.map((value) => ({
								value,
								label: `${value.toLowerCase()} and worse`,
							})),
						},
					]}
				/>
				{live ? null : (
					<span className="text-[11.5px] text-subtle-foreground">Live updates paused while filtered.</span>
				)}
			</div>

			<LogStream lines={page.lines} live={live} />

			{skip > 0 || page.more ? (
				<div className="flex items-center gap-2">
					{skip > 0 ? (
						<Button
							variant="outline"
							size="sm"
							render={<Link href={query({ skip: String(Math.max(0, skip - LOG_PAGE_SIZE)) })} />}
						>
							Newer
						</Button>
					) : null}
					{page.more ? (
						<Button variant="outline" size="sm" render={<Link href={query({ skip: String(skip + LOG_PAGE_SIZE) })} />}>
							Older
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
