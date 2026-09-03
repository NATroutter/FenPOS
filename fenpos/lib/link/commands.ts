import "server-only";
import { ApiError } from "@/lib/errors";
import type { CommandResultFrame, DeviceCommand, PortsResultFrame, SerialPortInfo } from "@/lib/link/protocol";
import { getLink } from "@/lib/link/registry";
import { awaitReply, newRequestId, RequestTimeoutError } from "@/lib/link/requests";
import { logger } from "@/lib/logger";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * Asking an agent to do something, and waiting for the answer.
 *
 * Everything here fails rather than hangs. A panel action that spins forever because a agent
 * went away mid-request is worse than an error: the operator cannot tell whether it worked, so
 * they press it again, and now two of whatever it was are in flight.
 */

/**
 * How long a serial scan may take, in milliseconds. Enumerating ports touches hardware and is not
 * instant — a machine with many COM ports needs longer, which is why this is `link.scanTimeoutSeconds`
 * rather than a constant.
 *
 * @returns the configured timeout, converted from the setting's seconds to the milliseconds `awaitReply` wants
 */
async function scanTimeoutMs(): Promise<number> {
	return (await integerSetting("link.scanTimeoutSeconds")) * 1000;
}

/**
 * How long a device action may take, in milliseconds. Opening a port is the slowest of them.
 *
 * Shared by {@link sendDeviceCommand} and {@link sendRawWrite} — one setting,
 * `link.commandTimeoutSeconds`, read at each call site rather than once at module load, so a change
 * saved mid-request takes effect on the next one rather than requiring a restart.
 *
 * @returns the configured timeout, converted from the setting's seconds to the milliseconds `awaitReply` wants
 */
async function commandTimeoutMs(): Promise<number> {
	return (await integerSetting("link.commandTimeoutSeconds")) * 1000;
}

/**
 * Asks an agent what serial ports it can see.
 *
 * The panel's port picker is filled from this rather than from a text field. An operator
 * configuring a printer is usually not sitting at the machine it is plugged into, and a
 * mistyped port name fails as a device that simply never connects — which looks identical to
 * broken hardware and is diagnosed nowhere near the typo.
 *
 * @param agentId the agent to ask
 * @returns the ports it reported
 * @throws ApiError when the agent is not connected or does not answer
 */
export async function scanPorts(agentId: string): Promise<SerialPortInfo[]> {
	const link = getLink(agentId);
	if (!link) {
		throw new ApiError("agent_offline", "That agent is not connected, so it cannot be scanned.");
	}

	const requestId = newRequestId();
	const waiting = awaitReply<PortsResultFrame>(requestId, await scanTimeoutMs());

	if (!link.send({ type: "ports.scan", requestId })) {
		throw new ApiError("agent_offline", "That agent disconnected before the scan was sent.");
	}

	try {
		const result = await waiting;
		logger.info("Scanned an agent's serial ports", { agentId, count: result.ports.length });
		return result.ports;
	} catch (error) {
		throw asApiError(error, "The agent did not answer the scan.");
	}
}

/**
 * Asks an agent to act on one of its printers.
 *
 * The agent's own message is passed through on failure. "Could not open COM3; it may be in use
 * by another process" is the sentence that tells an operator what to do, and only the machine
 * holding the port can produce it — anything composed here would be a guess dressed up as a
 * diagnosis.
 *
 * @param agentId the agent holding the printer
 * @param command what to do
 * @param deviceName the printer to act on
 * @param options `jobId`, for `device.test` only: the job row the agent should report the page
 *                under, so the page it composes shows in the Jobs tab like a dispatched job
 * @returns the agent's message, when it sent one
 * @throws ApiError when the agent is not connected, does not answer, or refuses
 */
export async function sendDeviceCommand(
	agentId: string,
	command: DeviceCommand,
	deviceName: string,
	options: { jobId?: string } = {},
): Promise<string | undefined> {
	const link = getLink(agentId);
	if (!link) {
		throw new ApiError("agent_offline", "That agent is not connected.");
	}

	const requestId = newRequestId();
	const waiting = awaitReply<CommandResultFrame>(requestId, await commandTimeoutMs());

	const frame = options.jobId
		? { type: command, requestId, device: deviceName, jobId: options.jobId }
		: { type: command, requestId, device: deviceName };
	if (!link.send(frame)) {
		throw new ApiError("agent_offline", "That agent disconnected before the command was sent.");
	}

	let result: CommandResultFrame;
	try {
		result = await waiting;
	} catch (error) {
		throw asApiError(error, "The agent did not answer.");
	}

	if (!result.ok) {
		throw new ApiError("device_unavailable", result.message ?? "The agent could not do that.");
	}

	logger.info("Agent command succeeded", { agentId, command, deviceName });
	return result.message;
}

/**
 * Converts a wait failure into something the panel can render.
 *
 * @param error what went wrong
 * @param timeoutMessage what to say when the agent simply never answered
 * @returns the error to throw
 */
function asApiError(error: unknown, timeoutMessage: string): ApiError {
	if (error instanceof RequestTimeoutError) {
		return new ApiError("agent_offline", `${timeoutMessage} ${error.message}`);
	}
	if (error instanceof Error) {
		return new ApiError("agent_offline", error.message);
	}
	return new ApiError("internal_error", "Something went wrong talking to the agent.");
}

/**
 * Sends bytes to a printer to be written unmodified.
 *
 * Kept alongside the device commands because it uses the same correlation and the same timeout,
 * but deliberately its own function: this is the one call in the system that hands arbitrary
 * bytes to hardware, and giving it a name of its own means every call site is greppable.
 *
 * @param agentId the agent holding the printer
 * @param deviceName the printer to write to
 * @param bytes the payload, base64 encoded
 * @returns the agent's message, when it sent one
 * @throws ApiError when the agent is not connected, does not answer, or refuses
 */
export async function sendRawWrite(agentId: string, deviceName: string, bytes: string): Promise<string | undefined> {
	const link = getLink(agentId);
	if (!link) {
		throw new ApiError("agent_offline", "That agent is not connected.");
	}

	const requestId = newRequestId();
	const waiting = awaitReply<CommandResultFrame>(requestId, await commandTimeoutMs());

	if (!link.send({ type: "raw.write", requestId, device: deviceName, bytes })) {
		throw new ApiError("agent_offline", "That agent disconnected before the bytes were sent.");
	}

	let result: CommandResultFrame;
	try {
		result = await waiting;
	} catch (error) {
		// A raw write that timed out may or may not have reached the printer. Said plainly,
		// because the operator is the only one who can go and look at the paper.
		throw asApiError(error, "The agent did not answer; the bytes may or may not have been written.");
	}

	if (!result.ok) {
		throw new ApiError("device_unavailable", result.message ?? "The agent could not write those bytes.");
	}

	return result.message;
}
