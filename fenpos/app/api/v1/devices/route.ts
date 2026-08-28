import { apiRoute } from "@/lib/api/api-route";
import { deviceView } from "@/lib/api/device-view";
import { requireApiRead } from "@/lib/auth/rate-limit";
import { grantedDevices } from "@/lib/keys/authenticate";
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

export const GET = apiRoute("api:GET /v1/devices", async ({ key }) => {
	await requireApiRead(key.id);

	const devices = await grantedDevices(key);

	return {
		response: Response.json({
			devices: devices.map((device) => deviceView(device, getDeviceStatus(device.agentId, device.name))),
		}),
		// No target: a listing is about the grant as a whole, not about any one device in it.
		message: `Listed ${devices.length} granted devices`,
	};
});
