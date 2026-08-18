import "server-only";
import type { ConnectionStatus } from "@/lib/domain/enums";
import type { DeviceStatus } from "@/lib/link/protocol";

/**
 * What each printer is actually doing, as its agent last reported.
 *
 * Observed state, held only in memory. The database records what an operator *configured* — the
 * port, the paper width, whether printing should be held. This records what is *true right now*,
 * and the two are different things: a device can be configured to auto-connect and still be
 * unplugged. Persisting this would produce a value that is wrong from the moment the server
 * restarts, since no port survives that.
 *
 * A device with no entry has never been reported on, which the panel shows as unknown rather
 * than as disconnected. The distinction matters while an agent is still connecting.
 *
 * Held on `globalThis` so a development hot reload does not lose every agent's reported state.
 */

/** One printer's observed state, with when it was reported. */
export interface ObservedDevice {
	connection: ConnectionStatus;
	paused: boolean;
	queueDepth: number;
	reportedAt: Date;
}

const globalForStatus = globalThis as unknown as {
	fenposDeviceStatus: Map<string, Map<string, ObservedDevice>> | undefined;
};

if (!globalForStatus.fenposDeviceStatus) {
	globalForStatus.fenposDeviceStatus = new Map();
}

/** Agent id to device name to state. */
const byAgent: Map<string, Map<string, ObservedDevice>> = globalForStatus.fenposDeviceStatus;

/**
 * Records an agent's report.
 *
 * The report is a whole snapshot, so it replaces rather than merges. Merging would leave a
 * device that has been deleted showing its last known state forever.
 *
 * @param agentId the agent reporting
 * @param devices the state of each of its devices
 */
export function recordStatus(agentId: string, devices: DeviceStatus[]): void {
	const now = new Date();
	const replacement = new Map<string, ObservedDevice>();
	for (const device of devices) {
		replacement.set(device.name, {
			connection: device.connection,
			paused: device.paused,
			queueDepth: device.queueDepth,
			reportedAt: now,
		});
	}
	byAgent.set(agentId, replacement);
}

/**
 * Returns what is known about one printer.
 *
 * @param agentId the agent it belongs to
 * @param deviceName the printer
 * @returns its state, or undefined when nothing has been reported
 */
export function getDeviceStatus(agentId: string, deviceName: string): ObservedDevice | undefined {
	return byAgent.get(agentId)?.get(deviceName);
}

/**
 * Returns everything known about one agent's printers.
 *
 * @param agentId the agent
 * @returns device name to state; empty when nothing has been reported
 */
export function getAgentStatus(agentId: string): Map<string, ObservedDevice> {
	return byAgent.get(agentId) ?? new Map();
}

/**
 * Forgets an agent's reported state.
 *
 * Called when its connection closes. Keeping the last report would show a printer as connected
 * long after the machine driving it went away, which is worse than showing nothing: it is a
 * confident wrong answer rather than an obvious absence.
 *
 * @param agentId the agent that disconnected
 */
export function clearAgentStatus(agentId: string): void {
	byAgent.delete(agentId);
}
