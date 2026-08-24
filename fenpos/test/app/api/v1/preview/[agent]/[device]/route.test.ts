import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/v1/preview/[agent]/[device]/route";
import { apiReadLimiter } from "@/lib/auth/rate-limit";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

/**
 * `POST /api/v1/preview/{agent}/{device}` — what would this print.
 *
 * The status semantics are the point. Markup with a mistake in it comes back as a 200 carrying the
 * mistake, because the request succeeded — the caller asked a question and got a complete answer.
 * Only the credential, the grant and the envelope can produce a non-2xx here, which is what lets a
 * client tell "your receipt is wrong" from "your key is wrong" without reading a body.
 */

let token: string;
let agentName: string;
let keyId: string;

/**
 * @param body the request body to send
 * @param device the device name in the path
 * @returns the arguments to spread into `POST`
 */
function call(body: unknown, device = "kitchen"): [Request, { params: Promise<{ agent: string; device: string }> }] {
	return [
		new Request(`https://fenpos.test/api/v1/preview/${agentName}/${device}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ agent: agentName, device }) },
	];
}

beforeEach(async () => {
	await prisma.job.deleteMany();
	await prisma.apiKeyDevice.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	agentName = agent.name;
	const kitchen = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 20 },
	});
	await prisma.device.create({ data: { agentId: agent.id, name: "bar", port: "COM4", columns: 32 } });

	token = `fp_${Date.now()}_${Math.random()}`;
	const key = await prisma.apiKey.create({
		data: {
			name: "till",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "print" }] },
			devices: { create: [{ deviceId: kitchen.id }] },
		},
	});
	keyId = key.id;
	apiReadLimiter.reset(key.id);
});

describe("POST /api/v1/preview/{agent}/{device}", () => {
	it("returns the lines the receipt would print", async () => {
		const response = await POST(...call({ data: ["Total 5.50"] }));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.errors).toEqual([]);
		expect(body.lines[0].spans.map((span: { text: string }) => span.text).join("")).toBe("Total 5.50");
		expect(body.columns).toBe(20);
	});

	it("answers 200 with the fault when the markup does not compile", async () => {
		const response = await POST(...call({ data: ["<bold>unclosed"] }));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.lines).toBeNull();
		expect(body.errors[0].code).toBe("unclosed_tag");
		expect(body.errors[0].line).toBe(1);
	});

	it("never creates a job", async () => {
		await POST(...call({ data: ["Total 5.50"] }));

		expect(await prisma.job.count()).toBe(0);
	});

	it("works for a device whose agent is not connected, unlike printing", async () => {
		// No link is registered anywhere in this file, so this passing *is* the assertion.
		expect((await POST(...call({ data: ["hi"] }))).status).toBe(200);
	});

	it("refuses a body that is not JSON", async () => {
		const response = await POST(
			new Request(`https://fenpos.test/api/v1/preview/${agentName}/kitchen`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: "{",
			}),
			{ params: Promise.resolve({ agent: agentName, device: "kitchen" }) },
		);

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_json");
	});

	it("refuses a key without 'print'", async () => {
		await prisma.apiKeyPermission.deleteMany({ where: { apiKeyId: keyId } });

		expect((await POST(...call({ data: ["hi"] }))).status).toBe(403);
	});

	it("reports an ungranted device as unknown", async () => {
		const response = await POST(...call({ data: ["hi"] }, "bar"));

		expect(response.status).toBe(404);
		expect((await response.json()).error).toBe("unknown_device");
	});
});
