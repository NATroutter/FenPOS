import { apiActionSchema, commandFor, PERSISTS_PAUSE } from "@/lib/api/device-actions";
import { setDevicePaused } from "@/lib/devices/device-service";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { authenticateKey, requireGrantedDevice, requirePermission } from "@/lib/keys/authenticate";
import { sendDeviceCommand } from "@/lib/link/commands";
import { logger } from "@/lib/logger";

/**
 * `POST /api/v1/devices/{agent}/{device}/actions` — asking an agent to act on one printer.
 *
 * **The stored state is written before the command is sent, and only for the actions that have
 * one.** Pausing is a decision this server holds and pushes to the agent on every reconnect; a
 * pause that only sent a frame would be silently undone the next time the agent restarted, which is
 * the failure an operator is least equipped to diagnose — the printer starts printing again and
 * nothing says why.
 *
 * The reverse risk, a stored pause whose command never arrived, is the safe direction: the device
 * is recorded as paused, the panel shows it as paused, and the next config push makes it true.
 *
 * Connect, disconnect and clear-queue persist nothing. A connection and a queue belong to the
 * machine holding the port, and this server has no column that could be right about either.
 */

export async function POST(
	request: Request,
	context: { params: Promise<{ agent: string; device: string }> },
): Promise<Response> {
	const { agent, device } = await context.params;

	try {
		const key = await authenticateKey(request);
		requirePermission(key, "devices:control");

		const target = await requireGrantedDevice(key, agent, device);
		const action = await readAction(request);

		const persists = PERSISTS_PAUSE[action];
		if (persists !== undefined) {
			await setDevicePaused(target.id, persists);
		}

		const message = await sendDeviceCommand(target.agentId, commandFor(action), target.name);

		logger.info("Device action taken through the API", {
			keyId: key.id,
			agentName: agent,
			deviceName: device,
			action,
		});

		return Response.json({ agent, device, action, message: message ?? null });
	} catch (error) {
		return toErrorResponse(error, { route: "POST /api/v1/devices/[agent]/[device]/actions", agent, device });
	}
}

/**
 * Reads the requested action from the body.
 *
 * @param request the incoming request
 * @returns the validated action
 * @throws ApiError when the body is not JSON, or names an action this API does not define
 */
async function readAction(request: Request): Promise<ReturnType<typeof apiActionSchema.parse>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new ApiError("invalid_json", "Body is not valid JSON");
	}

	const parsed = apiActionSchema.safeParse((body as { action?: unknown })?.action);
	if (!parsed.success) {
		throw new ApiError("invalid_type", "'action' must be one of connect, disconnect, pause, resume, clearQueue.");
	}

	return parsed.data;
}
