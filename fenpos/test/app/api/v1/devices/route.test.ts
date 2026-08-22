import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/devices/route";
import { apiReadLimiter } from "@/lib/auth/rate-limit";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { recordStatus } from "@/lib/link/device-status";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * `GET /api/v1/devices` — what a key can see of the install.
 *
 * The test that matters most is the one asserting an ungranted device is absent. This endpoint is
 * the first in the system that returns a *list* of printers, so it is the first place the
 * enumeration defence in `requireGrantedDevice` could be undone by accident: that function refuses
 * to confirm one name at a time, and a listing that ignored grants would hand over every name at
 * once.
 */

let token: string;
let keyId: string;
let agentId: string;

/**
 * Builds a request carrying a bearer credential.
 *
 * @param bearer the token to present, defaulting to the granted key minted in `beforeEach`
 * @returns a `Request` ready to hand to `GET`
 */
function requestWith(bearer: string = token): Request {
	return new Request("https://fenpos.test/api/v1/devices", {
		headers: { authorization: `Bearer ${bearer}` },
	});
}

beforeEach(async () => {
	await prisma.apiKeyDevice.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	agentId = agent.id;
	const kitchen = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 42, codepage: "CP858" },
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
	keyId = key.id;
	apiReadLimiter.reset(key.id);
});

describe("GET /api/v1/devices", () => {
	it("lists the devices the key grants", async () => {
		const response = await GET(requestWith());
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.devices).toHaveLength(1);
		expect(body.devices[0].device).toBe("kitchen");
		expect(body.devices[0].columns).toBe(42);
	});

	it("omits devices the key does not grant, so the list cannot map the install", async () => {
		const body = await (await GET(requestWith())).json();

		expect(body.devices.map((device: { device: string }) => device.device)).not.toContain("bar");
	});

	it("includes observed state once the agent has reported", async () => {
		recordStatus(agentId, [{ name: "kitchen", connection: "CONNECTED", paused: false, queueDepth: 2 }]);

		const body = await (await GET(requestWith())).json();

		expect(body.devices[0].observed.connection).toBe("CONNECTED");
		expect(body.devices[0].observed.queueDepth).toBe(2);
	});

	it("refuses a caller with no credential", async () => {
		const response = await GET(new Request("https://fenpos.test/api/v1/devices"));

		expect(response.status).toBe(401);
		expect((await response.json()).error).toBe("missing_key");
	});

	it("refuses a key without the permission", async () => {
		await prisma.apiKeyPermission.deleteMany({ where: { apiKeyId: keyId } });

		const response = await GET(requestWith());

		expect(response.status).toBe(403);
		expect((await response.json()).error).toBe("insufficient_permission");
	});

	it("throttles a key that reads too often", async () => {
		await setSetting("api.readsPerMinute", 1);

		await GET(requestWith());
		const response = await GET(requestWith());

		expect(response.status).toBe(429);
		expect((await response.json()).error).toBe("rate_limited");
	});
});
