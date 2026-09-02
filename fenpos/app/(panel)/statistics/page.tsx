import { AutoRefresh } from "@/app/(panel)/statistics/auto-refresh";
import { CollectionOffNotice } from "@/app/(panel)/statistics/collection-off-notice";
import { StatisticsNav } from "@/app/(panel)/statistics/statistics-nav";
import { TabContent } from "@/app/(panel)/statistics/tab-content";
import { isTabId } from "@/app/(panel)/statistics/tabs";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { resolveRange } from "@/lib/metrics/range";
import { globalStatsSettings } from "@/lib/settings/settings-service";

export const metadata = { title: "Statistics" };

/** Never cached: every control on this page rewrites the URL and expects a fresh read behind it. */
export const dynamic = "force-dynamic";

/**
 * The Statistics page.
 *
 * A shell today. `TabContent` renders a placeholder `Empty` for every tab until Task 13 replaces it
 * with real charts, but the URL contract this page reads — `?tab=&range=&from=&to=&agent=&device=`
 * — is the one every later task queries with, so it is parsed once, here, and handed down rather than
 * re-parsed per chart.
 *
 * Collection being off (`stats.enabled`) does not hide the page: an account with `stats:read` and no
 * way to flip that setting itself should still be able to see whatever was already rolled up, with
 * {@link CollectionOffNotice} explaining why it may be thin.
 */
export default async function StatisticsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | undefined>>;
}) {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("stats:read", "/statistics");

	const params = await searchParams;
	const stats = await globalStatsSettings();
	const range = resolveRange({ preset: params.range, from: params.from, to: params.to });
	const filter = { agentId: params.agent, deviceId: params.device };
	const tab = isTabId(params.tab) ? params.tab : "overview";

	// Agents and devices for the filter combobox. Read here, server-side, rather than inside
	// `StatisticsNav` — a Client Component cannot reach the database directly.
	const [agents, devices] = await Promise.all([
		prisma.agent.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
		prisma.device.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, agentId: true } }),
	]);

	return (
		<div className="flex flex-col gap-5">
			{stats.autoRefreshSeconds > 0 ? <AutoRefresh seconds={stats.autoRefreshSeconds} /> : null}
			{!stats.enabled ? <CollectionOffNotice /> : null}
			<StatisticsNav tab={tab} params={params} agents={agents} devices={devices} />
			<TabContent tab={tab} range={range} filter={filter} />
		</div>
	);
}
