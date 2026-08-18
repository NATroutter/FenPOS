import type { ToolDevice } from "@/app/(panel)/tools/device-picker";
import { MarkupTool } from "@/app/(panel)/tools/markup-tool";
import { RawTool } from "@/app/(panel)/tools/raw-tool";
import { prisma } from "@/lib/db";
import { isConnected } from "@/lib/link/registry";

export const metadata = { title: "Tools · FenPOS" };

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
	const rows = await prisma.device.findMany({
		orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
		select: { id: true, name: true, agentId: true, agent: { select: { name: true } } },
	});

	const devices: ToolDevice[] = rows.map((row) => ({
		id: row.id,
		label: `${row.agent.name}/${row.name}`,
		online: isConnected(row.agentId),
	}));

	return (
		<div className="flex flex-col gap-5">
			<div className="border-b border-border pb-3">
				<h2 className="text-[15px] font-semibold tracking-tight">Tools</h2>
				<p className="mt-1 text-[12.5px] text-muted-foreground">
					Compose a receipt and see where it lands on the paper, or send bytes straight to a printer.
				</p>
			</div>

			<MarkupTool devices={devices} />
			<RawTool devices={devices} />
		</div>
	);
}
