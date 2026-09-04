import type { TabId } from "@/app/(panel)/statistics/tabs";
import { ApiTab } from "@/app/(panel)/statistics/tabs/api-tab";
import { FleetTab } from "@/app/(panel)/statistics/tabs/fleet-tab";
import { JobsTab } from "@/app/(panel)/statistics/tabs/jobs-tab";
import { LatencyTab } from "@/app/(panel)/statistics/tabs/latency-tab";
import { OverviewTab } from "@/app/(panel)/statistics/tabs/overview-tab";
import { ReliabilityTab } from "@/app/(panel)/statistics/tabs/reliability-tab";
import { SecurityTab } from "@/app/(panel)/statistics/tabs/security-tab";
import { WebhooksTab } from "@/app/(panel)/statistics/tabs/webhooks-tab";
import type { ResolvedRange } from "@/lib/metrics/range";

/** The agent/device narrowing every tab's query takes, read from `?agent=` and `?device=`. */
export interface StatisticsFilter {
	agentId?: string;
	deviceId?: string;
}

/**
 * Renders the body for the active tab: one of the eight tab server components, each fetching its
 * own `*TabData` shape and laying out its own `ChartCard`s.
 */
export function TabContent({ tab, range, filter }: { tab: TabId; range: ResolvedRange; filter: StatisticsFilter }) {
	switch (tab) {
		case "overview":
			return <OverviewTab range={range} filter={filter} />;
		case "jobs":
			return <JobsTab range={range} filter={filter} />;
		case "reliability":
			return <ReliabilityTab range={range} filter={filter} />;
		case "latency":
			return <LatencyTab range={range} filter={filter} />;
		case "fleet":
			return <FleetTab range={range} filter={filter} />;
		case "webhooks":
			return <WebhooksTab range={range} filter={filter} />;
		case "api":
			return <ApiTab range={range} filter={filter} />;
		case "security":
			return <SecurityTab range={range} filter={filter} />;
		default: {
			const _exhaustive: never = tab;
			return _exhaustive;
		}
	}
}
