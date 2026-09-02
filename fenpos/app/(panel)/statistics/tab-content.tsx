import { ChartColumn } from "lucide-react";
import { TAB_LABELS, type TabId } from "@/app/(panel)/statistics/tabs";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { formatDate } from "@/lib/format/datetime";
import type { ResolvedRange } from "@/lib/metrics/range";

/** The agent/device narrowing every tab's query takes, read from `?agent=` and `?device=`. */
export interface StatisticsFilter {
	agentId?: string;
	deviceId?: string;
}

/**
 * Renders the body for the active tab.
 *
 * Every tab is a placeholder `<Empty>` until Task 13 replaces it with real charts — the point of
 * this task is that the shell renders end to end, URL contract and all, before a single chart
 * exists. `range` and `filter` are already exactly what a chart on this tab would query with, so the
 * placeholder names them rather than sitting there inert: this is a server component, and a prop this
 * task received but never read would be the kind of drift `pnpm typecheck` cannot catch on its own.
 */
export function TabContent({ tab, range, filter }: { tab: TabId; range: ResolvedRange; filter: StatisticsFilter }) {
	return (
		<Empty className="min-h-64 rounded-xl border border-dashed border-border">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ChartColumn />
				</EmptyMedia>
				<EmptyTitle>{TAB_LABELS[tab]} is not built yet</EmptyTitle>
				<EmptyDescription>
					This tab will chart {formatDate(range.from)} through {formatDate(range.to)}
					{filter.agentId ? ", narrowed to one agent" : ""}
					{filter.deviceId ? ", narrowed to one printer" : ""}.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
