import { apiRoute } from "@/lib/api/api-route";
import { deviceView } from "@/lib/api/device-view";
import { requireApiRead } from "@/lib/auth/rate-limit";
import { grantedDevice } from "@/lib/keys/authenticate";
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

export const GET = apiRoute<{ agent: string; device: string }>(
	"api:GET /v1/devices/{agent}/{device}",
	async ({ key, params }) => {
		await requireApiRead(key.id);

		const target = await grantedDevice(key, params.agent, params.device);

		return {
			response: Response.json(deviceView(target, getDeviceStatus(target.agentId, target.name))),
			message: `Read device '${target.name}' on '${target.agentName}'`,
			// The stored names rather than the path segments, and available here because the grant
			// check resolved the row — see the raw-write route's own note on why that distinction
			// matters for a line an operator reads.
			target: {
				agentId: target.agentId,
				agentName: target.agentName,
				deviceId: target.id,
				deviceName: target.name,
			},
		};
	},
);
