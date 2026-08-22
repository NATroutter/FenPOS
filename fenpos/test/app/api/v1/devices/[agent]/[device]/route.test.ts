import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/devices/[agent]/[device]/route";
import { apiReadLimiter } from "@/lib/auth/rate-limit";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

/**
 * `GET /api/v1/devices/{agent}/{device}` — one printer.
 *
 * The last test is the point of this file: the same device name must answer the same way whether
 * the device is ungranted or gone entirely, down to the code and the message. Anything less and a
 * caller can map the install by probing one name and watching which 404 it gets.
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

	it("answers the same way whether a device is ungranted or gone, so a name cannot be probed", async () => {
		// The same name asked twice: once while 'bar' exists but is not granted, once after it is
		// gone. A caller that could tell those apart could map every printer in the install by
		// probing names and watching which answer came back.
		const ungranted = await GET(...call(agentName, "bar"));
		const ungrantedBody = await ungranted.json();

		await prisma.device.deleteMany({ where: { name: "bar" } });

		const gone = await GET(...call(agentName, "bar"));

		expect(ungranted.status).toBe(404);
		expect(gone.status).toBe(404);
		expect(await gone.json()).toEqual(ungrantedBody);
	});
});
