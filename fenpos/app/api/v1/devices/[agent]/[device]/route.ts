import { deviceView } from "@/lib/api/device-view";
import { requireApiRead } from "@/lib/auth/rate-limit";
import { toErrorResponse } from "@/lib/errors";
import { authenticateKey, grantedDevice, requirePermission } from "@/lib/keys/authenticate";
import { getDeviceStatus } from "@/lib/link/device-status";

/**
 * `GET /api/v1/devices/{agent}/{device}` — one printer's configuration and state.
 *
 * Addressed by the same agent-scoped path a print uses, so a caller that can print to a device can
 * read it without learning a second addressing scheme. A device this key does not grant is reported
 * as unknown, exactly as a device that does not exist is — see `requireGrantedDevice`.
 */

/** Never cached: pause state and queue depth are the reason anyone calls this. */
export const dynamic = "force-dynamic";

export async function GET(
	request: Request,
	context: { params: Promise<{ agent: string; device: string }> },
): Promise<Response> {
	const { agent, device } = await context.params;

	try {
		const key = await authenticateKey(request);
		requirePermission(key, "devices:read");

		await requireApiRead(key.id);

		const target = await grantedDevice(key, agent, device);

		return Response.json(deviceView(target, getDeviceStatus(target.agentId, target.name)));
	} catch (error) {
		return toErrorResponse(error, { route: "GET /api/v1/devices/[agent]/[device]", agent, device });
	}
}
