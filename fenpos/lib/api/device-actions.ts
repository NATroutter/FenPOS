import { z } from "zod";
import type { DeviceCommand } from "@/lib/link/protocol";

/**
 * The device actions an API key may take, and how they reach the agent.
 *
 * Two vocabularies meet in this file. `DEVICE_COMMANDS` in the link protocol are dotted frame types
 * the agent switches on; these are short verbs an integrator types into a request body. Keeping the
 * mapping explicit means the wire may be renamed without breaking a published contract, and the
 * public surface may stay smaller than the wire's — which it does.
 *
 * `device.test` is deliberately absent. It prints a diagnostic page, and a print is a print: it
 * belongs behind the `print` permission, not behind `devices:control`. A key granted control of a
 * printer it may not print to must not be able to make it print by another name.
 */

/** The action names accepted in a request body. */
export const API_DEVICE_ACTIONS = ["connect", "disconnect", "pause", "resume", "clearQueue"] as const;

export type ApiDeviceAction = (typeof API_DEVICE_ACTIONS)[number];

/** Validates the `action` field of a request body. */
export const apiActionSchema = z.enum(API_DEVICE_ACTIONS);

/** One public action to the wire command it sends. */
const COMMANDS = {
	connect: "device.connect",
	disconnect: "device.disconnect",
	pause: "device.pause",
	resume: "device.resume",
	clearQueue: "device.clearQueue",
} as const satisfies Record<ApiDeviceAction, DeviceCommand>;

/**
 * Which actions also change the stored desired state, and to what.
 *
 * Pause and resume are the two that persist: `Device.paused` is this server's record of what an
 * operator wants and is pushed to the agent on reconnect, so an action that only sent a frame would
 * be undone by the next agent restart. The rest are transient — a connection or a queue is state the
 * agent owns, and this server has no column that could be right about it.
 *
 * `undefined` means "sends only", and is distinct from `false`, which means "persist not-paused".
 * Every action is listed explicitly and the object is `satisfies Record<ApiDeviceAction, …>`, the
 * same discipline `COMMANDS` above uses, so a new action fails to compile here too until someone
 * decides `undefined` or a boolean for it — `Partial` let a sixth action compile silently with no
 * persistence decision made at all, which is exactly the gap `COMMANDS`' own `satisfies` closes.
 */
export const PERSISTS_PAUSE = {
	connect: undefined,
	disconnect: undefined,
	pause: true,
	resume: false,
	clearQueue: undefined,
} as const satisfies Record<ApiDeviceAction, boolean | undefined>;

/**
 * The wire command one public action sends.
 *
 * @param action the validated public action name
 * @returns the link protocol command
 */
export function commandFor(action: ApiDeviceAction): DeviceCommand {
	return COMMANDS[action];
}
