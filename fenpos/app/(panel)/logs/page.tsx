import { Archive } from "lucide-react";
import Link from "next/link";
import { Filters } from "@/app/(panel)/jobs/filters";
import { FollowProvider, FollowToggle } from "@/app/(panel)/logs/follow";
import { LogStream } from "@/app/(panel)/logs/log-stream";
import { buttonVariants } from "@/components/ui/button";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { dayBound } from "@/lib/format/datetime";
import { archiveCovering, FILTERABLE_LEVELS, isFilterableLevel, listLogs } from "@/lib/logs/log-service";
import { isLogSortColumn } from "@/lib/logs/log-sort";
import { integerSetting } from "@/lib/settings/settings-service";
import { parseKnownValues, parseValues } from "@/lib/table/multi-filter";

export const metadata = { title: "Logs" };

/** Never cached: lines arrive without any request to this page causing them. */
export const dynamic = "force-dynamic";

/**
 * The signpost's own styling: the muted, unalarmed tone the Audit tab's banner uses for its
 * not-yet-verified state. Nothing has gone wrong here — the record is exactly where retention put
 * it — so this must not read as a warning.
 */
const SIGNPOST =
	"flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 p-3 text-muted-foreground";

/**
 * The Logs tab.
 *
 * What the agents chose to forward, not everything they logged. Each agent keeps its own complete
 * log on its own machine; this is the subset an operator watching the panel would act on. A log
 * that carried every line from every site would be one nobody reads.
 *
 * **This tab shows the live window, and says so when a range reaches past it.** Retention moves
 * whole months out of `logs.db` into the archive directory, so a filter reaching back far enough
 * returns a short page or an empty one — and without the signpost below, separating live from
 * archived would only move the operator's failure from "the data is gone" to "the data is somewhere
 * nobody told you to look". `archiveCovering` decides whether there is anything to point at, and the
 * banner is not rendered at all when there is not.
 */
export default async function LogsPage({
	searchParams,
}: {
	searchParams: Promise<{
		agent?: string;
		key?: string;
		level?: string;
		from?: string;
		to?: string;
		skip?: string;
		sort?: string;
		dir?: string;
	}>;
}) {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("logs:read", "/logs");

	const params = await searchParams;
	const skip = Math.max(0, Number.parseInt(params.skip ?? "0", 10) || 0);
	// Each filter holds as many values as were ticked. Anything else in the URL — including `DEBUG`,
	// which the dropdown has never offered — is dropped, so a stale bookmark cannot put a value in a
	// trigger the dropdown has no label for.
	const agentIds = parseValues(params.agent);
	const keyIds = parseValues(params.key);
	const levels = parseKnownValues(params.level, isFilterableLevel);
	const sort = params.sort && isLogSortColumn(params.sort) ? params.sort : undefined;
	const desc = params.dir ? params.dir !== "asc" : undefined;
	const from = dayBound(params.from, "start");
	const to = dayBound(params.to, "end");
	// Either end alone is a range: "everything since March" and "everything up to March" both narrow
	// the view, and both can reach back past the live window.
	const ranged = from !== undefined || to !== undefined;

	const pageSize = await integerSetting("panel.logPageSize");

	const [agents, keys, page, covering] = await Promise.all([
		prisma.agent.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
		// Revoked keys included: a key stops working the moment it is revoked, and the lines it wrote
		// before that are exactly the ones somebody comes here to read afterwards.
		prisma.apiKey.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
		listLogs({ agentId: agentIds, apiKeyId: keyIds, level: levels, from, to, skip, sort, desc, take: pageSize }),
		// Only when a range has actually been asked for. An unfiltered tab is not asking about a stretch
		// of history, so the oldest archive on disk would appear under every default page load — a
		// signpost that is always there is scenery, and stops being read long before it matters.
		ranged ? archiveCovering({ from, to }) : null,
	]);

	// The live stream is paused whenever a filter, a page or a sort is in play. A filter or a page
	// would be shown lines it excludes; a sort would have them pushed onto the top of an ordering
	// that does not put them there. In every case the arriving line contradicts what the view says
	// it is, so the honest move is to stop and let the operator reload.
	const live = agentIds.length === 0 && keyIds.length === 0 && levels.length === 0 && !ranged && skip === 0 && !sort;

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
				{/* Bottom-aligned, not centred: every control carries a label above it, and a label that
				    wraps would otherwise push its own control out of line with the rest of the row. */}
				<div className="flex flex-wrap items-end gap-3">
					<Filters
						filters={[
							{
								name: "agent",
								label: "Agent",
								values: agentIds,
								options: agents.map((agent) => ({ value: agent.id, label: agent.name })),
							},
							{
								name: "key",
								label: "Key",
								values: keyIds,
								options: keys.map((key) => ({ value: key.id, label: key.name })),
							},
							{
								// Plain level names, not "warn and worse": the dropdown holds as many as are
								// ticked, so the set is the filter — see `FILTERABLE_LEVELS`.
								name: "level",
								label: "Level",
								values: levels,
								options: FILTERABLE_LEVELS.map((value) => ({ value, label: value.toLowerCase() })),
							},
						]}
						range={{ from: params.from ?? "", to: params.to ?? "" }}
					/>

					<div className="flex-1" />

					{/* Beside the toggle rather than under the list: it is the reason the toggle is
				    disabled, and the two only read correctly together. */}
					{live ? null : (
						<span className="text-[11.5px] text-subtle-foreground">Live updates paused while filtered.</span>
					)}
					<FollowToggle />
				</div>

				{/* Above the list, not under it: it is the reason the list is short, and an operator who
				    has to scroll past an empty table to find out where the rest went has already had the
				    experience this banner exists to prevent. */}
				{covering === null ? null : (
					<div className={SIGNPOST}>
						<Archive className="size-4 shrink-0" />
						<p className="min-w-0 flex-1 text-[12px]">
							This range reaches back before the live window. The lines from {covering} left this list when that period
							aged out, and are in the archive for it.
						</p>
						{/* A link wearing a button's clothes — see the same pair on the Audit page. */}
						<Link href="/archives" className={buttonVariants({ variant: "outline", size: "sm" })}>
							Open the archives
						</Link>
					</div>
				)}

				<LogStream lines={page.lines} />

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
		</FollowProvider>
	);
}
