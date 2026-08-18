import { Construction } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

/**
 * Placeholder for a section whose implementation belongs to a later phase.
 *
 * States plainly which phase delivers the section rather than rendering a convincing but
 * inert screen. A shell that looks finished invites the assumption that it works, and the
 * cost of that assumption lands on whoever tries to use it during a service.
 */
export function PendingSection({
	phase,
	summary,
}: {
	/** Phase from the design document that delivers this section. */
	phase: string;
	/** What the section will do once built. */
	summary: string;
}) {
	return (
		<Empty className="border border-dashed border-border">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Construction />
				</EmptyMedia>
				<EmptyTitle>Not built yet</EmptyTitle>
				<EmptyDescription>
					{summary}
					<span className="mt-2 block font-mono text-xs text-subtle-foreground">Scheduled for {phase}</span>
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
