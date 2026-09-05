import { Server } from "lucide-react";
import { AddAgentDialog } from "@/app/(panel)/agents/add-agent-dialog";
import { AgentCard, type AgentCardData } from "@/app/(panel)/agents/agent-card";
import { AGENT_PERMISSIONS } from "@/app/(panel)/tab-permits";
import { LiveRefresh } from "@/components/panel/live-refresh";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { listAgents } from "@/lib/agents/agent-service";
import { permitsFor } from "@/lib/auth/permits";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { isConnected } from "@/lib/link/registry";
import { getPublicAddress } from "@/lib/public-url";
import { booleanSetting } from "@/lib/settings/settings-service";

export const metadata = { title: "Agents" };

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
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("agents:read", "/agents");

	const [agents, address, pairingEnabled, permits] = await Promise.all([
		listAgents(),
		getPublicAddress(),
		booleanSetting("pairing.enabled"),
		// Resolved here because a client component cannot read the database. Convenience only — every
		// action is refused again by its own gate; see `permitsFor`.
		permitsFor(user, AGENT_PERMISSIONS),
	]);

	const cards: AgentCardData[] = agents.map((agent) => ({
		id: agent.id,
		name: agent.name,
		// Awaiting pairing is a property of the credential, not of the code: an unpaired agent whose
		// code has lapsed is still unpaired, and the card must still offer a way to issue one.
		status: !agent.paired ? "PENDING" : isConnected(agent.id) ? "ONLINE" : "OFFLINE",
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
			<LiveRefresh kinds={["agent"]} />
			{/* The section's own description is in the top bar; what is left here is the one action
			    this page offers, kept on its own row so it stays put as the grid below changes. */}
			<div className="flex justify-end">{permits["agents:create"] ? <AddAgentDialog /> : null}</div>

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
							agentWillRefuse={address.agentWillRefuse}
							pairingEnabled={pairingEnabled}
							permits={permits}
						/>
					))}
				</div>
			)}
		</div>
	);
}
