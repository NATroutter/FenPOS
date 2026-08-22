import { deviceView } from "@/lib/api/device-view";
import { consumeApiRead } from "@/lib/auth/rate-limit";
import { prisma } from "@/lib/db";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { authenticateKey, requireGrantedDevice, requirePermission } from "@/lib/keys/authenticate";
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

		const limit = await consumeApiRead(key.id);
		if (!limit.allowed) {
			throw new ApiError("rate_limited", "Too many requests from this key. Try again shortly.", {
				retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000),
			});
		}

		const target = await requireGrantedDevice(key, agent, device);

		// `requireGrantedDevice` returns the minimum the print path needs and is deliberately not
		// widened for this endpoint's benefit. The second read is affordable here and not there.
		const row = await prisma.device.findUnique({
			where: { id: target.id },
			select: {
				id: true,
				name: true,
				agentId: true,
				port: true,
				columns: true,
				codepage: true,
				defaultLinefeed: true,
				paused: true,
				maxQueueDepth: true,
				agent: { select: { name: true } },
			},
		});

		if (!row) {
			// Deleted between the grant check and this read. Reported as unknown rather than as a
			// fault, because from the caller's side that is exactly what it is.
			throw new ApiError("unknown_device", `No device '${device}' on agent '${agent}'.`);
		}

		return Response.json(
			deviceView(
				{
					id: row.id,
					name: row.name,
					agentId: row.agentId,
					agentName: row.agent.name,
					port: row.port,
					columns: row.columns,
					codepage: row.codepage,
					defaultLinefeed: row.defaultLinefeed,
					paused: row.paused,
					maxQueueDepth: row.maxQueueDepth,
				},
				getDeviceStatus(row.agentId, row.name),
			),
		);
	} catch (error) {
		return toErrorResponse(error, { route: "GET /api/v1/devices/[agent]/[device]", agent, device });
	}
}
