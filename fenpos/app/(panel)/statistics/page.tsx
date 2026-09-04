import { AutoRefresh } from "@/app/(panel)/statistics/auto-refresh";
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
 * Entirely URL-driven: `?tab=&range=&from=&to=&agent=&device=` is parsed once, here, and handed down
 * rather than re-parsed per chart, which is what lets every control on the page — the tab strip, the
 * range picker, the agent/device filter — act by rewriting the URL instead of holding client state.
 * `TabContent` dispatches `tab` to one of eight data-backed tab Server Components (overview, jobs,
 * reliability, latency, fleet, webhooks, api, security — see `tabs.ts`), each fetching its own metrics
 * and laying out its charts itself.
 *
 * Collection being off (`stats.enabled`) removes the page: the section names that setting as its
 * switch in `lib/navigation.ts`, so `requirePagePermission` sends the caller to `/no-access` with a
 * note naming it, and the sidebar stops offering the tab. Nothing here has to check the switch itself.
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
			<StatisticsNav tab={tab} params={params} agents={agents} devices={devices} />
			<TabContent tab={tab} range={range} filter={filter} />
		</div>
	);
}
