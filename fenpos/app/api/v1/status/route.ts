import { apiRoute } from "@/lib/api/api-route";
import { deviceView } from "@/lib/api/device-view";
import { requireApiRead } from "@/lib/auth/rate-limit";
import { prisma } from "@/lib/db";
import { type GrantedDevice, grantedDevices } from "@/lib/keys/authenticate";
import { getDeviceStatus } from "@/lib/link/device-status";

/**
 * `GET /api/v1/status` — agent liveness and printer readiness, for the printers this key grants.
 *
 * Grouped by agent, which is the shape of the answer rather than a presentational choice. When a
 * shop's machine is off, every printer behind it is unreachable for exactly one reason; a flat list
 * of disconnected devices invites one investigation per printer into a single fault.
 *
 * Distinct from `/api/health`, which stays deliberately contentless because it is unauthenticated —
 * counts of agents and devices there would turn a container probe into a way to watch an install
 * from outside it. This endpoint requires `status:read`, which `API_ROUTES` declares and `apiRoute`
 * enforces, and may therefore say more.
 */

/** Never cached: liveness is the entire content. */
export const dynamic = "force-dynamic";

export const GET = apiRoute("api:GET /v1/status", async ({ key }) => {
	await requireApiRead(key.id);

	const devices = await grantedDevices(key);
	const byAgent = new Map<string, GrantedDevice[]>();
	for (const device of devices) {
		const existing = byAgent.get(device.agentId);
		if (existing) {
			existing.push(device);
		} else {
			byAgent.set(device.agentId, [device]);
		}
	}

	const rows = await prisma.agent.findMany({
		where: { id: { in: [...byAgent.keys()] } },
		select: { id: true, name: true, status: true, lastSeenAt: true, agentVersion: true },
		orderBy: { name: "asc" },
	});

	return {
		response: Response.json({
			agents: rows.map((row) => ({
				agent: row.name,
				status: row.status,
				lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
				agentVersion: row.agentVersion,
				devices: (byAgent.get(row.id) ?? []).map((device) =>
					deviceView(device, getDeviceStatus(device.agentId, device.name)),
				),
			})),
		}),
		// No target: the answer spans every agent this key grants, so naming one on the row would be
		// picking an arbitrary member of the set the request was about.
		message: `Reported status for ${rows.length} agents and ${devices.length} devices`,
	};
});
