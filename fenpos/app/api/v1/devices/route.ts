import { deviceView } from "@/lib/api/device-view";
import { requireApiRead } from "@/lib/auth/rate-limit";
import { toErrorResponse } from "@/lib/errors";
import { authenticateKey, grantedDevices, requirePermission } from "@/lib/keys/authenticate";
import { getDeviceStatus } from "@/lib/link/device-status";

/**
 * `GET /api/v1/devices` — the printers this key may address.
 *
 * **The list is the grant, not the install.** A key sees exactly the devices an operator granted it
 * and learns nothing about the rest — the same rule `requireGrantedDevice` enforces one name at a
 * time, applied to the whole collection. A key confined to one site cannot discover the others.
 *
 * Not paginated. The size of this list is something an operator chose when granting devices, so
 * there is nothing here that grows without their involvement, and a cursor on a list of five would
 * be ceremony every caller has to implement for nothing.
 */

/** Never cached: pause state and queue depth are the reason anyone calls this. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
	try {
		const key = await authenticateKey(request);
		requirePermission(key, "devices:read");

		await requireApiRead(key.id);

		const devices = await grantedDevices(key);

		return Response.json({
			devices: devices.map((device) => deviceView(device, getDeviceStatus(device.agentId, device.name))),
		});
	} catch (error) {
		return toErrorResponse(error, { route: "GET /api/v1/devices" });
	}
}
