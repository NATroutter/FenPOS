import { Wrench } from "lucide-react";
import { TOOL_PERMISSIONS } from "@/app/(panel)/tab-permits";
import type { ToolDevice } from "@/app/(panel)/tools/device-picker";
import { MarkupTool } from "@/app/(panel)/tools/markup-tool";
import { RawTool } from "@/app/(panel)/tools/raw-tool";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { permitsFor } from "@/lib/auth/permits";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { isConnected } from "@/lib/link/registry";

export const metadata = { title: "Tools" };

/** Never cached: which agents are reachable changes without a request causing it. */
export const dynamic = "force-dynamic";

/**
 * The Tools tab.
 *
 * Two things an operator needs when a printer is not behaving: compose markup and see exactly
 * what it will produce, or drive the printer in its own language when the markup layer is not the
 * problem. They are separate cards because they answer different questions, and putting them
 * behind one editor would invite sending a receipt as raw bytes.
 */
export default async function ToolsPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("tools:read", "/tools");

	const [rows, permits] = await Promise.all([
		prisma.device.findMany({
			orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
			select: {
				id: true,
				name: true,
				agentId: true,
				columns: true,
				codepage: true,
				agent: { select: { name: true } },
			},
		}),
		// Resolved here because a client component cannot read the database. Convenience only — every
		// action is refused again by its own gate; see `permitsFor`.
		permitsFor(user, TOOL_PERMISSIONS),
	]);

	// The markup card is an editor whose output goes to one of two places. With neither, it composes
	// text nothing can be done with, so it is not shown at all.
	const showMarkup = permits["tools:preview"] || permits["tools:print"];

	const devices: ToolDevice[] = rows.map((row) => ({
		id: row.id,
		agentName: row.agent.name,
		deviceName: row.name,
		columns: row.columns,
		codepage: row.codepage,
		online: isConnected(row.agentId),
	}));

	return (
		<div className="flex flex-col gap-5">
			{showMarkup ? (
				<MarkupTool devices={devices} canPreview={permits["tools:preview"]} canPrint={permits["tools:print"]} />
			) : null}
			{permits["tools:raw"] ? <RawTool devices={devices} /> : null}

			{/* `tools:read` on its own is a real grant — it is what lets the markup documentation name
			    the images and variables that exist — so this page can legitimately have nothing to
			    show. Saying so beats a blank page that looks like a failure. */}
			{!showMarkup && !permits["tools:raw"] ? (
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Wrench />
						</EmptyMedia>
						<EmptyTitle>Nothing to compose with</EmptyTitle>
						<EmptyDescription>
							Composing markup needs the preview or print permission, and raw bytes need their own. Ask an administrator
							for whichever you need.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : null}
		</div>
	);
}
