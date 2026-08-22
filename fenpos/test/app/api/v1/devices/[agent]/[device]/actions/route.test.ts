import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

/**
 * `POST /api/v1/devices/{agent}/{device}/actions` — acting on a printer through the API.
 *
 * `sendDeviceCommand` is mocked rather than stood up against a fake agent: what is under test here
 * is the route's authorisation, validation and persistence, and a real link would only add a
 * WebSocket to the setup of every case. The one thing the mock must prove is that the *right*
 * command reached it, which is asserted on its arguments.
 */
vi.mock("@/lib/link/commands", () => ({
	sendDeviceCommand: vi.fn(async () => "done"),
}));

const { POST } = await import("@/app/api/v1/devices/[agent]/[device]/actions/route");
const { sendDeviceCommand } = await import("@/lib/link/commands");

let token: string;
let agentName: string;
let keyId: string;
let deviceId: string;

/**
 * Builds a request and route context for an action call.
 *
 * @param action the action name to send in the body
 * @param device the device name in the path
 * @returns the arguments to spread into `POST`
 */
function call(action: unknown, device = "kitchen"): [Request, { params: Promise<{ agent: string; device: string }> }] {
	return [
		new Request(`https://fenpos.test/api/v1/devices/${agentName}/${device}/actions`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ action }),
		}),
		{ params: Promise.resolve({ agent: agentName, device }) },
	];
}

beforeEach(async () => {
	vi.mocked(sendDeviceCommand).mockClear();

	await prisma.apiKeyDevice.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	agentName = agent.name;
	const kitchen = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 42 },
	});
	deviceId = kitchen.id;
	await prisma.device.create({ data: { agentId: agent.id, name: "bar", port: "COM4", columns: 32 } });

	token = `fp_${Date.now()}_${Math.random()}`;
	const key = await prisma.apiKey.create({
		data: {
			name: "till",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "devices:control" }] },
			devices: { create: [{ deviceId: kitchen.id }] },
		},
	});
	keyId = key.id;
});

describe("POST /api/v1/devices/{agent}/{device}/actions", () => {
	it("sends the mapped command to the agent", async () => {
		const response = await POST(...call("connect"));

		expect(response.status).toBe(200);
		expect(vi.mocked(sendDeviceCommand)).toHaveBeenCalledWith(expect.any(String), "device.connect", "kitchen");
	});

	it("persists a pause, so it survives an agent restart", async () => {
		await POST(...call("pause"));

		expect((await prisma.device.findUnique({ where: { id: deviceId } }))?.paused).toBe(true);
	});

	it("persists a resume", async () => {
		await prisma.device.update({ where: { id: deviceId }, data: { paused: true } });

		await POST(...call("resume"));

		expect((await prisma.device.findUnique({ where: { id: deviceId } }))?.paused).toBe(false);
	});

	it("leaves the stored state alone for transient actions", async () => {
		await POST(...call("clearQueue"));

		expect((await prisma.device.findUnique({ where: { id: deviceId } }))?.paused).toBe(false);
	});

	it("refuses an action it does not define", async () => {
		const response = await POST(...call("explode"));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_type");
		expect(vi.mocked(sendDeviceCommand)).not.toHaveBeenCalled();
	});

	it("refuses the test print, which belongs behind 'print'", async () => {
		const response = await POST(...call("test"));

		expect(response.status).toBe(400);
		expect(vi.mocked(sendDeviceCommand)).not.toHaveBeenCalled();
	});

	it("refuses a key without the permission", async () => {
		await prisma.apiKeyPermission.deleteMany({ where: { apiKeyId: keyId } });

		const response = await POST(...call("connect"));

		expect(response.status).toBe(403);
		expect(vi.mocked(sendDeviceCommand)).not.toHaveBeenCalled();
	});

	it("reports an ungranted device as unknown, and never touches the agent", async () => {
		const response = await POST(...call("connect", "bar"));

		expect(response.status).toBe(404);
		expect((await response.json()).error).toBe("unknown_device");
		expect(vi.mocked(sendDeviceCommand)).not.toHaveBeenCalled();
	});
});
