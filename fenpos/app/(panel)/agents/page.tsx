import { Server } from "lucide-react";
import { AddAgentDialog } from "@/app/(panel)/agents/add-agent-dialog";
import { AgentCard, type AgentCardData } from "@/app/(panel)/agents/agent-card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { listAgents } from "@/lib/agents/agent-service";
import { isConnected } from "@/lib/link/registry";
import { getPublicAddress } from "@/lib/public-url";

export const metadata = { title: "Agents · FenPOS" };

/**
 * Never cached: connection state changes without any request causing it to.
 */
export const dynamic = "force-dynamic";

/**
 * The Agents tab.
 *
 * Connection state is read from the in-memory registry rather than the stored column. The
 * column is written when a agent connects and disconnects, but a process that died without
 * running its close handlers would leave it stale — the registry is the only thing that
 * knows, right now, whether a socket exists. Showing a printer as reachable when it is not
 * is the failure worth avoiding here.
 */
export default async function AgentsPage() {
	const [agents, address] = await Promise.all([listAgents(), getPublicAddress()]);

	const cards: AgentCardData[] = agents.map((agent) => ({
		id: agent.id,
		name: agent.name,
		status: agent.pairing ? "PENDING" : isConnected(agent.id) ? "ONLINE" : "OFFLINE",
		lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
		agentVersion: agent.agentVersion,
		platform: agent.platform,
		hostname: agent.hostname,
		lastAddress: agent.lastAddress,
		deviceCount: agent.deviceCount,
		pairing: agent.pairing ? { code: agent.pairing.code, expiresAt: agent.pairing.expiresAt.toISOString() } : null,
	}));

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-wrap items-end gap-4 border-b border-border pb-3">
				<div className="min-w-[220px] flex-1">
					<h2 className="text-[15px] font-semibold tracking-tight">Agents</h2>
					<p className="mt-1 text-[12.5px] text-muted-foreground">
						Each agent is one machine with printers attached. Agents dial the server, so no inbound port needs opening
						at the site.
					</p>
				</div>
				<AddAgentDialog />
			</div>

			{cards.length === 0 ? (
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Server />
						</EmptyMedia>
						<EmptyTitle>No agents yet</EmptyTitle>
						<EmptyDescription>
							Add a agent to get a pairing code, then enter it on the machine the printers are attached to.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] items-stretch gap-4">
					{cards.map((agent) => (
						<AgentCard
							key={agent.id}
							agent={agent}
							serverAddress={address.url}
							addressIsInferred={address.source === "request"}
						/>
					))}
				</div>
			)}
		</div>
	);
}
