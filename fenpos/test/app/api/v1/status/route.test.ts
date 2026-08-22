import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/status/route";
import { apiReadLimiter } from "@/lib/auth/rate-limit";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { recordStatus } from "@/lib/link/device-status";

/**
 * `GET /api/v1/status` — is the site up, and are its printers ready.
 *
 * Grouped by agent because that is the shape of the answer. When a shop's machine is off, every
 * printer behind it is unreachable for one reason, and a flat list of five disconnected devices
 * invites five investigations of one fault.
 */

let token: string;
let onlineAgentId: string;
let otherAgentName: string;

beforeEach(async () => {
	await prisma.apiKeyDevice.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();

	const online = await prisma.agent.create({
		data: { name: `helsinki-${Date.now()}`, status: "ONLINE", agentVersion: "1.4.0", lastSeenAt: new Date() },
	});
	onlineAgentId = online.id;
	const kitchen = await prisma.device.create({
		data: { agentId: online.id, name: "kitchen", port: "COM3", columns: 42 },
	});

	const other = await prisma.agent.create({ data: { name: `tampere-${Date.now()}`, status: "OFFLINE" } });
	otherAgentName = other.name;
	await prisma.device.create({ data: { agentId: other.id, name: "counter", port: "COM1", columns: 42 } });

	token = `fp_${Date.now()}_${Math.random()}`;
	const key = await prisma.apiKey.create({
		data: {
			name: "till",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "status:read" }] },
			devices: { create: [{ deviceId: kitchen.id }] },
		},
	});
	apiReadLimiter.reset(key.id);
});

/**
 * @returns a request carrying the granted key's credential
 */
function requestWith(): Request {
	return new Request("https://fenpos.test/api/v1/status", { headers: { authorization: `Bearer ${token}` } });
}

describe("GET /api/v1/status", () => {
	it("reports the agent behind a granted device", async () => {
		const body = await (await GET(requestWith())).json();

		expect(body.agents).toHaveLength(1);
		expect(body.agents[0].status).toBe("ONLINE");
		expect(body.agents[0].agentVersion).toBe("1.4.0");
	});

	it("omits agents whose devices this key does not grant", async () => {
		const body = await (await GET(requestWith())).json();

		expect(body.agents.map((entry: { agent: string }) => entry.agent)).not.toContain(otherAgentName);
	});

	it("carries the granted devices under their agent", async () => {
		recordStatus(onlineAgentId, [{ name: "kitchen", connection: "CONNECTED", paused: false, queueDepth: 1 }]);

		const body = await (await GET(requestWith())).json();

		expect(body.agents[0].devices).toHaveLength(1);
		expect(body.agents[0].devices[0].device).toBe("kitchen");
		expect(body.agents[0].devices[0].observed.queueDepth).toBe(1);
	});

	it("refuses a key holding devices:read but not status:read", async () => {
		await prisma.apiKeyPermission.updateMany({ data: { permission: "devices:read" } });

		const response = await GET(requestWith());

		expect(response.status).toBe(403);
	});
});
