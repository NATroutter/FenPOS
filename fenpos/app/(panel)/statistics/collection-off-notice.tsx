import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Shown at the top of the Statistics page when `stats.enabled` is off.
 *
 * The tabs and controls beneath it still render — a caller with `stats:read` and no way to turn
 * collection on themselves should still be able to see the last-collected data, if any, rather than
 * losing the whole page to a message they cannot act on. This card only says why what follows may be
 * thin or stale.
 */
export function CollectionOffNotice() {
	return (
		<Card>
			<CardHeader className="flex flex-row items-center gap-2 border-b border-border pb-3">
				<AlertTriangle className="size-4.5 shrink-0 text-amber-400" />
				<h3 className="text-[13px] font-medium">Collection is off</h3>
			</CardHeader>
			<CardContent className="pt-4">
				<p className="text-[12px] text-subtle-foreground">
					Usage is not being sampled or rolled up, so the charts below may be empty or out of date. Turn it on under
					Settings → Statistics.
				</p>
			</CardContent>
		</Card>
	);
}
