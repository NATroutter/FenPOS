import { apiRoute } from "@/lib/api/api-route";
import { type ApiDeviceAction, apiActionSchema, commandFor, PERSISTS_PAUSE } from "@/lib/api/device-actions";
import { setDevicePaused } from "@/lib/devices/device-service";
import { ApiError } from "@/lib/errors";
import { requireGrantedDevice } from "@/lib/keys/authenticate";
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

/**
 * Largest body accepted. An action body is `{ "action": "clearQueue" }` — the longest action name
 * plus its field — which is under 40 bytes; this leaves headroom for whitespace and an integrator's
 * formatting without moving off the same order of magnitude as the payload the endpoint actually
 * reads.
 */
const MAX_BODY_BYTES = 256;

export const POST = apiRoute<{ agent: string; device: string }>(
	"api:POST /v1/devices/{agent}/{device}/actions",
	async ({ key, request, params }) => {
		const { agent, device } = params;

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

		return {
			response: Response.json({ agent, device, action, message: message ?? null }),
			message: `Sent '${action}' to '${target.name}'`,
			// `agent` is the path segment, but the grant check matched it against the device's actual
			// agent by exact name, so it is the verified name rather than the caller's claim of it —
			// the same reasoning the raw-write route relies on for this field.
			target: { agentId: target.agentId, agentName: agent, deviceId: target.id, deviceName: target.name },
		};
	},
);

/**
 * Reads the requested action from the body.
 *
 * Size is checked on the raw text before parsing, the same discipline `readBody` in the print route
 * uses and for the same reason: parsing is the work an oversized body is trying to provoke, so the
 * check has to happen before `JSON.parse` ever sees the bytes.
 *
 * @param request the incoming request
 * @returns the validated action
 * @throws ApiError when the body is too large, not JSON, missing `action`, or names an action this
 *   API does not define
 */
async function readAction(request: Request): Promise<ApiDeviceAction> {
	const raw = await request.text();

	if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
		throw new ApiError("body_too_large", `Request body must be under ${MAX_BODY_BYTES} bytes.`);
	}

	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		throw new ApiError("invalid_json", "Body is not valid JSON");
	}

	const action = (body as { action?: unknown })?.action;
	if (action === undefined || action === null) {
		throw new ApiError("missing_field", "'action' is required");
	}

	const parsed = apiActionSchema.safeParse(action);
	if (!parsed.success) {
		throw new ApiError("invalid_type", "'action' must be one of connect, disconnect, pause, resume, clearQueue.");
	}

	return parsed.data;
}
