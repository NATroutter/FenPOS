import { Construction } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

/**
 * Placeholder for a section that has not been built yet.
 *
 * Says so plainly rather than rendering a convincing but inert screen. A shell that looks
 * finished invites the assumption that it works, and the cost of that assumption lands on
 * whoever tries to use it during a service.
 */
export function PendingSection({
	summary,
}: {
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
				<EmptyDescription>{summary}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
