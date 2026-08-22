import type { GrantedDevice } from "@/lib/keys/authenticate";
import type { ObservedDevice } from "@/lib/link/device-status";

/**
 * How one printer appears in every API response that mentions one.
 *
 * Configuration and observed state are separated deliberately. The configuration is what this
 * server holds and is always true; the observed block is what an agent last said, which may be
 * stale and may be absent entirely. Flattening them would present a queue depth from four minutes
 * ago with the same confidence as the codepage.
 */
export interface DeviceView {
	/** The agent's name, as it appears in a print path. */
	agent: string;
	/** The device's name, as it appears in a print path. Unique within the agent, not globally. */
	device: string;
	port: string;
	/** Printable columns. A caller composing fixed-width markup needs this. */
	columns: number;
	codepage: string;
	defaultLinefeed: string;
	/** Desired state, held by this server. Survives an agent restart. */
	paused: boolean;
	/** Configured queue ceiling, or null when the device inherits the install-wide one. */
	maxQueueDepth: number | null;
	/** What the agent last reported, or null when it has reported nothing since this server started. */
	observed: {
		connection: string;
		queueDepth: number;
		reportedAt: string;
	} | null;
}

/**
 * Shapes one granted device into its response body.
 *
 * @param device the granted device row
 * @param observed what the agent last reported for it, if anything
 * @returns the response body for this device
 */
export function deviceView(device: GrantedDevice, observed: ObservedDevice | undefined): DeviceView {
	return {
		agent: device.agentName,
		device: device.name,
		port: device.port,
		columns: device.columns,
		codepage: device.codepage,
		defaultLinefeed: device.defaultLinefeed,
		paused: device.paused,
		maxQueueDepth: device.maxQueueDepth,
		observed: observed
			? {
					connection: observed.connection,
					queueDepth: observed.queueDepth,
					reportedAt: observed.reportedAt.toISOString(),
				}
			: null,
	};
}
