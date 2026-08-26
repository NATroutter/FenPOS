import type { ToolDevice } from "@/app/(panel)/tools/device-picker";
import { MarkupTool } from "@/app/(panel)/tools/markup-tool";
import { RawTool } from "@/app/(panel)/tools/raw-tool";
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
	await requirePagePermission("tools:read", "/tools");

	const rows = await prisma.device.findMany({
		orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
		select: {
			id: true,
			name: true,
			agentId: true,
			columns: true,
			codepage: true,
			agent: { select: { name: true } },
		},
	});

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
			<MarkupTool devices={devices} />
			<RawTool devices={devices} />
		</div>
	);
}
