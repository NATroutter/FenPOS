"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { panelAction, panelQuery } from "@/lib/auth/panel-action";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
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
import { setDeviceOverride } from "@/lib/variables/variable-service";

/**
 * Server actions behind the Devices tab.
 *
 * Every action goes through the shared gate, which resolves the session, checks the permission its
 * registry entry names, runs the body, and records the attempt.
 */

/**
 * What every action here refreshes on success.
 *
 * Both tabs, because a printer's state is rendered on each: the Devices tab lists it directly, and
 * the Agents tab counts and summarises the printers behind each agent.
 */
const revalidate = () => {
	revalidatePath("/devices");
	revalidatePath("/agents");
};

/**
 * Adds a printer behind an agent.
 *
 * @param agentId the agent that will drive it
 * @param input the configuration
 * @returns the state to render
 */
export async function createDevice(agentId: string, input: DeviceInput): Promise<ActionState> {
	return panelAction(
		"devices:create",
		async () => {
			await createDeviceRecord(agentId, input);
		},
		{ revalidate, target: { kind: "device", label: input.name } },
	);
}

/**
 * Changes a printer's configuration.
 *
 * @param deviceId the printer to change
 * @param input the new configuration
 * @returns the state to render
 */
export async function updateDevice(deviceId: string, input: DeviceInput): Promise<ActionState> {
	return panelAction("devices:update", () => updateDeviceRecord(deviceId, input), {
		revalidate,
		target: { kind: "device", id: deviceId, label: input.name },
	});
}

/**
 * Removes a printer.
 *
 * @param deviceId the printer to remove
 * @returns the state to render
 */
export async function deleteDevice(deviceId: string): Promise<ActionState> {
	return panelAction("devices:delete", () => deleteDeviceRecord(deviceId), {
		revalidate,
		target: { kind: "device", id: deviceId },
	});
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
	return panelAction(
		"devices:pause",
		async () => {
			const device = await requireDevice(deviceId);
			await setDevicePaused(deviceId, paused);
			await sendDeviceCommand(device.agentId, paused ? "device.pause" : "device.resume", device.name);
		},
		// The boolean is recorded rather than split into two action ids: "who paused the kitchen
		// printer on Friday" is the question this row exists to answer.
		{ revalidate, target: { kind: "device", id: deviceId }, detail: { paused } },
	);
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
	return panelAction(
		"devices:connect",
		async () => {
			const device = await requireDevice(deviceId);
			await sendDeviceCommand(device.agentId, connected ? "device.connect" : "device.disconnect", device.name);
		},
		{ revalidate, target: { kind: "device", id: deviceId }, detail: { connected } },
	);
}

/**
 * Cancels every job waiting for a printer.
 *
 * @param deviceId the printer
 * @returns the state to render
 */
export async function clearQueue(deviceId: string): Promise<ActionState> {
	return panelAction(
		"devices:clear-queue",
		async () => {
			const device = await requireDevice(deviceId);
			await sendDeviceCommand(device.agentId, "device.clearQueue", device.name);
		},
		{ revalidate, target: { kind: "device", id: deviceId } },
	);
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
	return panelAction(
		"devices:test-page",
		async () => {
			const device = await requireDevice(deviceId);
			await sendDeviceCommand(device.agentId, "device.test", device.name);
		},
		{ revalidate, target: { kind: "device", id: deviceId } },
	);
}

/**
 * Sets or clears one printer's own value for a variable.
 *
 * `setDeviceOverride` already enforces every rule — that only a `STATIC` variable can be
 * overridden, that a value cannot carry a control character, that it cannot exceed
 * `variables.maxValueChars`, and that the variable must still exist — so this just calls it and
 * lets its `ApiError` become the message the dialog shows. `value: null` clears the override and
 * falls back to the install-wide value.
 *
 * @param deviceId the printer
 * @param variableId the variable
 * @param value the printer's own value, or null to clear it
 * @returns the state to render
 */
export async function saveDeviceOverride(
	deviceId: string,
	variableId: string,
	value: string | null,
): Promise<ActionState> {
	return panelAction("devices:override", () => setDeviceOverride(deviceId, variableId, value), {
		revalidate,
		target: { kind: "device", id: deviceId },
		// The variable is named; the value it was given is not. An override carries whatever an
		// operator typed, and a receipt's contents are not what this row exists to hold.
		detail: { variableId, cleared: value === null },
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
	return panelQuery<ScanResult>("devices:scan-ports", async () => ({ ports: await scanPorts(agentId), error: null }), {
		refused: () => ({ ports: [], error: REFUSAL_MESSAGE }),
		failed: (error) => {
			if (error instanceof ApiError) {
				return { ports: [], error: error.message };
			}
			logger.error("Port scan failed", error);
			return { ports: [], error: "Something went wrong. Check the server log." };
		},
		target: { kind: "agent", id: agentId },
	});
}
