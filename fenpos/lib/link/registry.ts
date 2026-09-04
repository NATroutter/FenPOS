import "server-only";
import type { ServerFrame } from "@/lib/link/protocol";

/**
 * The set of agents currently holding a live connection.
 *
 * This is observed state and it lives only in memory, which is the correct place for it: a
 * socket cannot outlive the process that owns it, so persisting "connected" would produce a
 * value that is wrong from the moment the server restarts. The database records what the
 * operator configured; this records what is actually reachable right now.
 *
 * Held on `globalThis` so that a development hot reload does not strand the previous
 * module's connections in an unreachable registry while new ones accumulate in a fresh Map.
 */

/** A live connection to one agent, as the rest of the server needs to use it. */
export interface AgentLink {
	readonly agentId: string;
	readonly agentName: string;
	/** When the agent connected. */
	readonly connectedAt: Date;
	/**
	 * Where it connected from.
	 *
	 * Carried so a displacement can name both sides. A bearer token knocks the holder of the previous
	 * connection offline every time it is used, which is inherent to bearer tokens and is also exactly
	 * what a stolen one looks like — and the difference between the two is visible only if the record
	 * says which address each connection came from.
	 */
	readonly address: string;
	/**
	 * Sends a frame to the agent.
	 *
	 * @param frame the frame to send
	 * @returns whether the frame was handed to the socket; false when it had already closed
	 */
	send(frame: ServerFrame): boolean;
	/**
	 * Closes the connection.
	 *
	 * @param reason short text recorded in the log and sent in the close frame
	 * @param code the close code to send; "going away" when omitted. An unpair passes its own
	 *             code, because the agent must tell being sent away from being revoked
	 */
	close(reason: string, code?: number): void;
}

const globalForRegistry = globalThis as unknown as {
	fenposAgentLinks: Map<string, AgentLink> | undefined;
};

if (!globalForRegistry.fenposAgentLinks) {
	globalForRegistry.fenposAgentLinks = new Map();
}

const links: Map<string, AgentLink> = globalForRegistry.fenposAgentLinks;

/**
 * Registers a connection, displacing any earlier one for the same agent.
 *
 * Displacement matters more than it looks. A agent whose network dropped without a clean
 * close reconnects while the server still holds the dead socket; without evicting the old
 * entry, dispatches would be written to a socket nobody is reading and the jobs would vanish
 * silently. The newest connection is always the live one.
 *
 * @param link the connection to register
 * @returns the displaced connection, if there was one
 */
export function registerLink(link: AgentLink): AgentLink | undefined {
	const previous = links.get(link.agentId);
	links.set(link.agentId, link);
	return previous;
}

/**
 * Removes a connection, but only if it is still the registered one.
 *
 * The identity check prevents a late close event from an already-displaced socket removing
 * its healthy replacement — a real ordering hazard, because the old socket's close fires
 * after the new one has registered.
 *
 * @param link the connection whose close is being handled
 * @returns whether this connection was the registered one and was removed
 */
export function unregisterLink(link: AgentLink): boolean {
	if (links.get(link.agentId) !== link) {
		return false;
	}
	links.delete(link.agentId);
	return true;
}

/**
 * Returns the live connection for a agent.
 *
 * @param agentId the agent to look up
 * @returns the connection, or undefined when the agent is not connected
 */
export function getLink(agentId: string): AgentLink | undefined {
	return links.get(agentId);
}

/**
 * Whether a agent is currently connected.
 *
 * @param agentId the agent to test
 * @returns true when a live connection exists
 */
export function isConnected(agentId: string): boolean {
	return links.has(agentId);
}

/**
 * The ids of every connected agent.
 *
 * @returns a snapshot, safe to iterate while connections come and go
 */
export function connectedAgentIds(): string[] {
	return [...links.keys()];
}

/**
 * Closes and removes every connection.
 *
 * Used at shutdown so agents are told the server is going away and reconnect promptly,
 * rather than waiting for a heartbeat to time out.
 *
 * @param reason text sent in the close frame
 * @returns how many connections were closed
 */
export function closeAllLinks(reason: string): number {
	const open = [...links.values()];
	links.clear();
	for (const link of open) {
		link.close(reason);
	}
	return open.length;
}
