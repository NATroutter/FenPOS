"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { getCurrentSession } from "@/lib/auth/session-cookie";
import {
	createDevice as createDeviceRecord,
	type DeviceInput,
	deleteDevice as deleteDeviceRecord,
	requireDevice,
	setDevicePaused,
	updateDevice as updateDeviceRecord,
} from "@/lib/devices/device-service";
import { ApiError } from "@/lib/errors";
import { scanPorts, sendDeviceCommand } from "@/lib/link/commands";
import type { SerialPortInfo } from "@/lib/link/protocol";
import { logger } from "@/lib/logger";

/**
 * Server actions behind the Devices tab.
 *
 * Every action re-checks the session. The panel layout already guards the page, but an action
 * is a POST endpoint in its own right: anything that trusted the layout would be callable
 * directly by anyone who knew the action id.
 */

/**
 * Rejects the call unless the request carries a valid administrator session.
 *
 * @throws ApiError when the caller is not signed in
 */
async function requireSession(): Promise<void> {
	if (!(await getCurrentSession())) {
		throw new ApiError("missing_key", "Not signed in.");
	}
}

/**
 * Runs an action, converting a failure into a message the panel can render.
 *
 * @param label short description used in the log line
 * @param work the action body
 * @returns the state to render
 */
async function run(label: string, work: () => Promise<void>): Promise<ActionState> {
	try {
		await requireSession();
		await work();
		revalidatePath("/devices");
		revalidatePath("/agents");
		return { error: null };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message };
		}
		logger.error(`Device action failed: ${label}`, error);
		return { error: "Something went wrong. Check the server log." };
	}
}

/**
 * Adds a printer behind an agent.
 *
 * @param agentId the agent that will drive it
 * @param input the configuration
 * @returns the state to render
 */
export async function createDevice(agentId: string, input: DeviceInput): Promise<ActionState> {
	return run("create", async () => {
		await createDeviceRecord(agentId, input);
	});
}

/**
 * Changes a printer's configuration.
 *
 * @param deviceId the printer to change
 * @param input the new configuration
 * @returns the state to render
 */
export async function updateDevice(deviceId: string, input: DeviceInput): Promise<ActionState> {
	return run("update", () => updateDeviceRecord(deviceId, input));
}

/**
 * Removes a printer.
 *
 * @param deviceId the printer to remove
 * @returns the state to render
 */
export async function deleteDevice(deviceId: string): Promise<ActionState> {
	return run("delete", () => deleteDeviceRecord(deviceId));
}

/**
 * Holds or releases printing on a printer.
 *
 * Written to the database and pushed to the agent, then commanded live. The stored flag is what
 * survives a restart; the command is what takes effect on a queue that is already running.
 *
 * @param deviceId the printer
 * @param paused whether to hold printing
 * @returns the state to render
 */
export async function setPaused(deviceId: string, paused: boolean): Promise<ActionState> {
	return run(paused ? "pause" : "resume", async () => {
		const device = await requireDevice(deviceId);
		await setDevicePaused(deviceId, paused);
		await sendDeviceCommand(device.agentId, paused ? "device.pause" : "device.resume", device.name);
	});
}

/**
 * Opens or closes a printer's serial port.
 *
 * Not stored: whether a port is open right now is observed state, and the printer's
 * `autoConnect` setting is what decides whether it opens on its own.
 *
 * @param deviceId the printer
 * @param connected whether to open the port
 * @returns the state to render
 */
export async function setConnected(deviceId: string, connected: boolean): Promise<ActionState> {
	return run(connected ? "connect" : "disconnect", async () => {
		const device = await requireDevice(deviceId);
		await sendDeviceCommand(device.agentId, connected ? "device.connect" : "device.disconnect", device.name);
	});
}

/**
 * Cancels every job waiting for a printer.
 *
 * @param deviceId the printer
 * @returns the state to render
 */
export async function clearQueue(deviceId: string): Promise<ActionState> {
	return run("clear queue", async () => {
		const device = await requireDevice(deviceId);
		await sendDeviceCommand(device.agentId, "device.clearQueue", device.name);
	});
}

/**
 * Prints a page exercising the printer's width, styles and codepage.
 *
 * Composed on the agent rather than here, deliberately: the page exists to prove what the
 * printer does with the settings the agent actually holds, and compiling it from this side's
 * copy would still pass if the two had diverged.
 *
 * @param deviceId the printer
 * @returns the state to render
 */
export async function printTestPage(deviceId: string): Promise<ActionState> {
	return run("test page", async () => {
		const device = await requireDevice(deviceId);
		await sendDeviceCommand(device.agentId, "device.test", device.name);
	});
}

/** The result of asking an agent what ports it can see. */
export interface ScanResult {
	ports: SerialPortInfo[];
	error: string | null;
}

/**
 * Asks an agent to enumerate its serial ports.
 *
 * Separate from the other actions because it returns data rather than a success flag, and
 * because the dialog calls it while open rather than on submit.
 *
 * @param agentId the agent to ask
 * @returns the ports it reported, or why it could not be asked
 */
export async function scanAgentPorts(agentId: string): Promise<ScanResult> {
	try {
		await requireSession();
		return { ports: await scanPorts(agentId), error: null };
	} catch (error) {
		if (error instanceof ApiError) {
			return { ports: [], error: error.message };
		}
		logger.error("Port scan failed", error);
		return { ports: [], error: "Something went wrong. Check the server log." };
	}
}
