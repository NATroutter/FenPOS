import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/devices/[agent]/[device]/route";
import { apiReadLimiter } from "@/lib/auth/rate-limit";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

/**
 * `GET /api/v1/devices/{agent}/{device}` — one printer.
 *
 * The pair of tests at the bottom is the point of this file: a device that does not exist and a
 * device that exists but is not granted must be indistinguishable, down to the code and the
 * message. Anything less and a caller can map the install by watching which 404 it gets.
 */

let token: string;
let agentName: string;

/**
 * Builds a request and the route context for one device path.
 *
 * @param agent the agent name in the path
 * @param device the device name in the path
 * @returns the arguments to spread into `GET`
 */
function call(agent: string, device: string): [Request, { params: Promise<{ agent: string; device: string }> }] {
	return [
		new Request(`https://fenpos.test/api/v1/devices/${agent}/${device}`, {
			headers: { authorization: `Bearer ${token}` },
		}),
		{ params: Promise.resolve({ agent, device }) },
	];
}

beforeEach(async () => {
	await prisma.apiKeyDevice.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	agentName = agent.name;
	const kitchen = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 42 },
	});
	await prisma.device.create({ data: { agentId: agent.id, name: "bar", port: "COM4", columns: 32 } });

	token = `fp_${Date.now()}_${Math.random()}`;
	const key = await prisma.apiKey.create({
		data: {
			name: "till",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "devices:read" }] },
			devices: { create: [{ deviceId: kitchen.id }] },
		},
	});
	apiReadLimiter.reset(key.id);
});

describe("GET /api/v1/devices/{agent}/{device}", () => {
	it("returns the granted device", async () => {
		const response = await GET(...call(agentName, "kitchen"));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.device).toBe("kitchen");
		expect(body.agent).toBe(agentName);
		expect(body.columns).toBe(42);
	});

	it("answers identically for a device that does not exist and one that is not granted", async () => {
		const missing = await GET(...call(agentName, "nowhere"));
		const forbidden = await GET(...call(agentName, "bar"));

		expect(missing.status).toBe(404);
		expect(forbidden.status).toBe(404);
		expect(await missing.json()).toEqual(await forbidden.json());
	});
});
